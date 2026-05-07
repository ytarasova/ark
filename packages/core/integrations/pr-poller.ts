/**
 * Pull-based GitHub PR monitoring.
 *
 * Polls `gh pr view` for sessions with pr_url set and review-gated stages.
 * Detects new reviews, steers agents with feedback, approves review gates.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type { Session } from "../../types/index.js";
import type { AppContext } from "../app.js";

import * as flow from "../services/flow.js";
import { formatReviewPrompt, type ReviewComment } from "./github-pr.js";
import { safeAsync } from "../safe.js";
import { DEFAULT_CHANNEL_BASE_URL } from "../constants.js";
import { logInfo, logDebug } from "../observability/structured-log.js";

const execFileAsync = promisify(execFile);

/** Cooldown between PR checks per session -- slightly under the 60s poll interval to account for jitter */
const POLL_COOLDOWN_MS = 55_000;

type GhExecFn = (args: string[]) => Promise<{ stdout: string }>;

const defaultGhExec: GhExecFn = async (args) => {
  return execFileAsync("gh", args, { encoding: "utf-8", timeout: 15_000 });
};

// Replaceable via setGhExec() for testing; allows mocking gh CLI calls without subprocess
let _ghExec: GhExecFn = defaultGhExec;

/** Replace the gh exec function (for testing). */
export function setGhExec(fn: GhExecFn): void {
  _ghExec = fn;
}

export interface PRPollerOptions {
  ghExec?: GhExecFn;
}

interface GhReview {
  author: { login: string };
  body: string;
  state: string;
  submittedAt: string;
}

interface GhPRData {
  title: string;
  number: number;
  state: string;
  reviews: GhReview[];
}

/**
 * Fetch PR data (reviews, title, number, state) via gh CLI.
 * Returns null if the CLI call fails.
 */
export async function fetchPRReviews(prUrl: string, ghExec: GhExecFn = _ghExec): Promise<GhPRData | null> {
  try {
    const { stdout } = await ghExec(["pr", "view", prUrl, "--json", "reviews,title,number,state"]);
    return JSON.parse(stdout) as GhPRData;
  } catch {
    return null;
  }
}

/**
 * Process new review feedback for a session: detect approvals, request changes,
 * store messages, log events, and steer running agents.
 */
export async function processReviewFeedback(
  app: AppContext,
  session: Session,
  data: GhPRData,
  config: Record<string, any>,
): Promise<void> {
  const previousCount = config.review_count ?? 0;
  const lastReviewTime = config.last_review_time ?? "";
  const reviews = data.reviews ?? [];

  if (reviews.length <= previousCount) return; // No new reviews

  const newReviews = reviews.filter((r) => r.submittedAt > lastReviewTime);
  if (newReviews.length === 0) return;

  // Update state
  await app.sessions.update(session.id, {
    config: {
      ...config,
      last_review_check: new Date().toISOString(),
      review_count: reviews.length,
      last_review_time: reviews[reviews.length - 1].submittedAt,
      pr_state: data.state,
    },
  });

  // Check for approvals
  const approvals = newReviews.filter((r) => r.state === "APPROVED");
  if (approvals.length > 0) {
    await app.events.log(session.id, "pr_approved", {
      actor: "github",
      data: {
        pr_url: session.pr_url,
        reviewers: approvals.map((r) => r.author.login),
      },
    });

    // Advance the review gate
    try {
      const { approveReviewGate } = await import("../services/review-gate.js");
      await approveReviewGate(app, session.id);
    } catch {
      logDebug("bridge", "gate may already be advanced");
    }
    return;
  }

  // Changes requested or comments - steer the agent
  const comments: ReviewComment[] = newReviews.map((r) => ({
    author: r.author.login,
    body: r.body || "(no comment body)",
  }));

  const prompt = formatReviewPrompt(data.title, data.number, comments, newReviews[0]?.state);

  // Store as message for the UI
  await app.messages.send(session.id, "system", prompt, "text");

  await app.events.log(session.id, "pr_review_feedback", {
    actor: "github",
    data: {
      pr_url: session.pr_url,
      reviewer_count: newReviews.length,
      state: newReviews[0]?.state,
    },
  });

  // Steer via channel if running
  if (session.status !== "running") return;

  const channelPort = await app.sessions.channelPort(session.id);
  const steerPayload = { type: "steer", sessionId: session.id, message: prompt, from: "github-review" };
  const delivered = await safeAsync(`pr-poller: deliverToChannel for ${session.id}`, async () => {
    const { deliverToChannel } = await import("../services/channel/deliver.js");
    await deliverToChannel(app, session, channelPort, steerPayload);
  });
  if (delivered) return;

  // Fallback: direct HTTP
  await safeAsync(`pr-poller: direct HTTP fallback for ${session.id}`, async () => {
    await fetch(`${DEFAULT_CHANNEL_BASE_URL}:${channelPort}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(steerPayload),
    });
  });
}

/**
 * Main poller tick. Called every 60s from the conductor.
 * Finds sessions with pr_url in review-gated stages and checks for new reviews.
 */
export async function pollPRReviews(app: AppContext, opts?: PRPollerOptions): Promise<void> {
  const sessions = (await app.sessions.list({ limit: 100 })) as Session[];
  const now = Date.now();

  for (const s of sessions) {
    if (!s.pr_url) continue;
    if (!["running", "waiting", "ready", "blocked"].includes(s.status)) continue;

    // Only poll sessions in review-gated stages
    const stageDef = s.stage ? flow.getStage(app, s.flow, s.stage) : null;
    if (stageDef?.gate !== "review") continue;

    // Cooldown: skip if checked within last 60 seconds
    const config = (s.config ?? {}) as Record<string, any>;
    const lastCheck = config.last_review_check ? new Date(config.last_review_check).getTime() : 0;
    if (now - lastCheck < POLL_COOLDOWN_MS) continue;

    try {
      await checkSessionPR(app, s, opts);
    } catch {
      logInfo("bridge", "Don't let one session's failure block others");
    }
  }
}

/**
 * Check a single session's PR for new review activity.
 */
export async function checkSessionPR(app: AppContext, session: Session, opts?: PRPollerOptions): Promise<void> {
  const config = session.config as Record<string, any>;
  const ghExec = opts?.ghExec ?? _ghExec;

  const data = await fetchPRReviews(session.pr_url!, ghExec);
  if (!data) return;

  // Update check timestamp
  await app.sessions.update(session.id, {
    config: { ...config, last_review_check: new Date().toISOString(), pr_state: data.state },
  });

  // PR merged or closed - stop polling
  if (data.state === "MERGED" || data.state === "CLOSED") {
    await app.events.log(session.id, "pr_status", {
      actor: "github",
      data: { state: data.state, pr_url: session.pr_url },
    });
    return;
  }

  await processReviewFeedback(app, session, data, config);
}

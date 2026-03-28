/**
 * Pull-based GitHub PR monitoring.
 *
 * Polls `gh pr view` for sessions with pr_url set and review-gated stages.
 * Detects new reviews, steers agents with feedback, approves review gates.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as store from "./store.js";
import * as flow from "./flow.js";
import { formatReviewPrompt, type ReviewComment } from "./github-pr.js";

const execFileAsync = promisify(execFile);

/** Replaceable exec function for testing. */
export let ghExec: (args: string[]) => Promise<{ stdout: string }> = async (args) => {
  return execFileAsync("gh", args, { encoding: "utf-8", timeout: 15_000 });
};

/** Replace the gh exec function (for testing). */
export function setGhExec(fn: typeof ghExec): void {
  ghExec = fn;
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
 * Main poller tick. Called every 60s from the conductor.
 * Finds sessions with pr_url in review-gated stages and checks for new reviews.
 */
export async function pollPRReviews(): Promise<void> {
  const sessions = store.listSessions({ limit: 100 });
  const now = Date.now();

  for (const session of sessions) {
    if (!session.pr_url) continue;
    if (!["running", "waiting", "ready", "blocked"].includes(session.status)) continue;

    // Only poll sessions in review-gated stages
    const stageDef = session.stage ? flow.getStage(session.flow, session.stage) : null;
    if (stageDef?.gate !== "review") continue;

    // Cooldown: skip if checked within last 60 seconds
    const config = (session.config ?? {}) as Record<string, any>;
    const lastCheck = config.last_review_check ? new Date(config.last_review_check).getTime() : 0;
    if (now - lastCheck < 55_000) continue;

    try {
      await checkSessionPR(session);
    } catch {
      // Don't let one session's failure block others
    }
  }
}

/**
 * Check a single session's PR for new review activity.
 */
export async function checkSessionPR(session: store.Session): Promise<void> {
  const config = (session.config ?? {}) as Record<string, any>;

  // Query GitHub via gh CLI
  let data: GhPRData;
  try {
    const { stdout } = await ghExec([
      "pr", "view", session.pr_url!,
      "--json", "reviews,title,number,state",
    ]);
    data = JSON.parse(stdout);
  } catch (e: any) {
    // gh CLI not available or PR not found - skip silently
    return;
  }

  // Update check timestamp
  store.updateSession(session.id, {
    config: { ...config, last_review_check: new Date().toISOString(), pr_state: data.state },
  });

  // PR merged or closed - stop polling
  if (data.state === "MERGED" || data.state === "CLOSED") {
    store.logEvent(session.id, "pr_status", {
      actor: "github",
      data: { state: data.state, pr_url: session.pr_url },
    });
    return;
  }

  // Find new reviews since last check
  const previousCount = config.review_count ?? 0;
  const lastReviewTime = config.last_review_time ?? "";
  const reviews = data.reviews ?? [];

  if (reviews.length <= previousCount) return; // No new reviews

  const newReviews = reviews.filter(r => r.submittedAt > lastReviewTime);
  if (newReviews.length === 0) return;

  // Update state
  store.updateSession(session.id, {
    config: {
      ...config,
      last_review_check: new Date().toISOString(),
      review_count: reviews.length,
      last_review_time: reviews[reviews.length - 1].submittedAt,
      pr_state: data.state,
    },
  });

  // Check for approvals
  const approvals = newReviews.filter(r => r.state === "APPROVED");
  if (approvals.length > 0) {
    store.logEvent(session.id, "pr_approved", {
      actor: "github",
      data: {
        pr_url: session.pr_url,
        reviewers: approvals.map(r => r.author.login),
      },
    });

    // Advance the review gate
    try {
      const { approveReviewGate } = await import("./session.js");
      approveReviewGate(session.id);
    } catch {}
    return;
  }

  // Changes requested or comments - steer the agent
  const comments: ReviewComment[] = newReviews.map(r => ({
    author: r.author.login,
    body: r.body || "(no comment body)",
  }));

  const prompt = formatReviewPrompt(data.title, data.number, comments, newReviews[0]?.state);

  // Store as message for TUI
  store.addMessage({
    session_id: session.id,
    role: "system",
    content: prompt,
    type: "text",
  });

  store.logEvent(session.id, "pr_review_feedback", {
    actor: "github",
    data: {
      pr_url: session.pr_url,
      reviewer_count: newReviews.length,
      state: newReviews[0]?.state,
    },
  });

  // Steer via channel if running
  if (session.status === "running") {
    const channelPort = store.sessionChannelPort(session.id);
    const payload = { type: "steer", sessionId: session.id, message: prompt, from: "github-review" };
    try {
      const { deliverToChannel } = await import("./conductor.js");
      await deliverToChannel(session, channelPort, payload);
    } catch {
      // Fallback: direct HTTP
      try {
        await fetch(`http://localhost:${channelPort}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch {}
    }
  }
}

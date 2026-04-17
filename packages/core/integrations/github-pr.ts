/**
 * GitHub PR utilities - session lookup, review comment extraction, prompt formatting.
 *
 * Used by pull-based PR monitoring to detect review feedback and steer agents.
 */

import { createHmac } from "crypto";
import type { AppContext } from "../app.js";
import { safeParseConfig } from "../util.js";
import type { Session, SessionStatus } from "../../types/index.js";
import { safeAsync } from "../safe.js";
import { DEFAULT_CHANNEL_BASE_URL } from "../constants.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ReviewComment {
  author: string;
  body: string;
  path?: string;
  line?: number;
}

export interface WebhookResult {
  action: "steer" | "approve" | "ignore";
  sessionId?: string;
  message?: string;
}

// ── Signature validation ────────────────────────────────────────────────────

export function validateSignature(payload: string, signature: string, secret: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  // Constant-time comparison
  if (signature.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < signature.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── Comment extraction ──────────────────────────────────────────────────────

export function extractComments(payload: Record<string, any>): ReviewComment[] {
  const comments: ReviewComment[] = [];

  // pull_request_review: top-level review body
  if (payload.review?.body && payload.review?.user?.login) {
    comments.push({
      author: payload.review.user.login,
      body: payload.review.body,
    });
  }

  // pull_request_review_comment: inline comment with path/line
  if (payload.comment?.body && payload.comment?.user?.login) {
    comments.push({
      author: payload.comment.user.login,
      body: payload.comment.body,
      path: payload.comment.path ?? undefined,
      line: payload.comment.line ?? payload.comment.original_line ?? undefined,
    });
  }

  return comments;
}

// ── Prompt formatting ───────────────────────────────────────────────────────

export function formatReviewPrompt(
  prTitle: string,
  prNumber: number,
  comments: ReviewComment[],
  state?: string,
): string {
  const parts: string[] = [];
  parts.push(`## PR Review — #${prNumber}: ${prTitle}`);

  if (state) {
    parts.push(`Review state: ${state}`);
  }

  parts.push("");
  for (const c of comments) {
    if (c.path && c.line) {
      parts.push(`**${c.author}** on \`${c.path}:${c.line}\`:`);
    } else if (c.path) {
      parts.push(`**${c.author}** on \`${c.path}\`:`);
    } else {
      parts.push(`**${c.author}**:`);
    }
    parts.push(c.body);
    parts.push("");
  }

  parts.push("Address the review feedback above, then push your changes.");
  return parts.join("\n");
}

// ── Session lookup ──────────────────────────────────────────────────────────

/** Raw row shape from the sessions table (config stored as JSON string). */
interface SessionRow {
  id: string;
  status: SessionStatus;
  flow: string;
  stage: string | null;
  agent: string | null;
  repo: string | null;
  branch: string | null;
  workdir: string | null;
  ticket: string | null;
  summary: string | null;
  pr_url: string | null;
  pr_id: string | null;
  error: string | null;
  config: string | null;
  parent_id: string | null;
  fork_group: string | null;
  group_name: string | null;
  compute_name: string | null;
  session_id: string | null;
  claude_session_id: string | null;
  breakpoint_reason: string | null;
  attached_by: string | null;
  created_at: string;
  updated_at: string;
}

export function findSessionByPR(app: AppContext, prUrl: string): Session | null {
  const db = app.db;
  const row = db.prepare("SELECT * FROM sessions WHERE pr_url = ? ORDER BY rowid DESC LIMIT 1").get(prUrl) as
    | SessionRow
    | undefined;
  if (!row) return null;
  return {
    ...row,
    config: safeParseConfig(row.config),
  };
}

// ── Main handler ────────────────────────────────────────────────────────────

export function handleGitHubWebhook(app: AppContext, event: string, payload: Record<string, any>): WebhookResult {
  // Only handle review-related events
  if (event !== "pull_request_review" && event !== "pull_request_review_comment") {
    return { action: "ignore", message: `Unhandled event: ${event}` };
  }

  // Extract PR URL
  const prUrl = payload.pull_request?.html_url;
  if (!prUrl) {
    return { action: "ignore", message: "No PR URL in payload" };
  }

  // Find matching session
  const session = findSessionByPR(app, prUrl);
  if (!session) {
    return { action: "ignore", message: `No session for PR: ${prUrl}` };
  }

  const prTitle = payload.pull_request?.title ?? "";
  const prNumber = payload.pull_request?.number ?? 0;
  const comments = extractComments(payload);

  // Handle approved reviews
  if (event === "pull_request_review" && payload.review?.state === "approved") {
    app.events.log(session.id, "webhook_review_approved", {
      actor: "github",
      data: { pr_url: prUrl, reviewer: payload.review?.user?.login },
    });
    return { action: "approve", sessionId: session.id, message: "Review approved" };
  }

  // Handle changes_requested or inline comments — steer the agent
  if (comments.length > 0) {
    const prompt = formatReviewPrompt(prTitle, prNumber, comments, payload.review?.state);

    // Store as a message so the UI shows it
    app.messages.send(session.id, "system", prompt, "text");

    app.events.log(session.id, "webhook_review_steer", {
      actor: "github",
      data: {
        pr_url: prUrl,
        event,
        reviewer: comments[0]?.author,
        comment_count: comments.length,
      },
    });

    // Steer via channel if session is running (fire-and-forget)
    if (session.status === "running") {
      const channelPort = app.sessions.channelPort(session.id);
      const steerPayload = { type: "steer", sessionId: session.id, message: prompt, from: "github-review" };
      safeAsync(`[github-pr] deliverToChannel for ${session.id}`, async () => {
        const { deliverToChannel } = await import("../conductor/conductor.js");
        await deliverToChannel(session, channelPort, steerPayload);
      })
        .then((delivered) => {
          if (!delivered) {
            safeAsync(`[github-pr] direct HTTP fallback for ${session.id}`, async () => {
              await fetch(`${DEFAULT_CHANNEL_BASE_URL}:${channelPort}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(steerPayload),
              });
            });
          }
        })
        .catch(() => {
          /* steer delivery is fire-and-forget -- session continues regardless */
        });
    }

    return { action: "steer", sessionId: session.id, message: prompt };
  }

  return { action: "ignore", sessionId: session.id, message: "No actionable comments" };
}

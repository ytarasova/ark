/**
 * Tests for GitHub webhook handler — HMAC validation, comment extraction,
 * session binding, and main webhook dispatch.
 */

import { createHmac } from "crypto";
import { describe, it, expect } from "bun:test";
import {
  updateSession,
} from "../index.js";
import { createSession } from "../store.js";
import {
  validateSignature,
  extractComments,
  formatReviewPrompt,
  findSessionByPR,
  handleGitHubWebhook,
} from "../github-pr.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

// ── validateSignature ────────────────────────────────────────────────────────

describe("validateSignature", () => {
  const secret = "test-webhook-secret";

  function sign(payload: string): string {
    return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  }

  it("returns true for correct secret", () => {
    const payload = '{"action":"submitted"}';
    const sig = sign(payload);
    expect(validateSignature(payload, sig, secret)).toBe(true);
  });

  it("returns false for wrong secret", () => {
    const payload = '{"action":"submitted"}';
    const sig = sign(payload);
    expect(validateSignature(payload, sig, "wrong-secret")).toBe(false);
  });

  it("returns false for empty signature", () => {
    const payload = '{"action":"submitted"}';
    expect(validateSignature(payload, "", secret)).toBe(false);
  });
});

// ── extractComments ──────────────────────────────────────────────────────────

describe("extractComments", () => {
  it("extracts review body from pull_request_review", () => {
    const payload = {
      review: {
        body: "Looks good but fix the typo",
        user: { login: "reviewer1" },
        state: "changes_requested",
      },
    };
    const comments = extractComments(payload);
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe("reviewer1");
    expect(comments[0].body).toBe("Looks good but fix the typo");
    expect(comments[0].path).toBeUndefined();
    expect(comments[0].line).toBeUndefined();
  });

  it("extracts line comment with path and line", () => {
    const payload = {
      comment: {
        body: "This variable should be const",
        user: { login: "reviewer2" },
        path: "src/main.ts",
        line: 42,
      },
    };
    const comments = extractComments(payload);
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe("reviewer2");
    expect(comments[0].body).toBe("This variable should be const");
    expect(comments[0].path).toBe("src/main.ts");
    expect(comments[0].line).toBe(42);
  });

  it("handles missing fields gracefully", () => {
    // No review, no comment
    expect(extractComments({})).toHaveLength(0);

    // Review without body
    expect(extractComments({ review: { user: { login: "x" } } })).toHaveLength(0);

    // Review without user
    expect(extractComments({ review: { body: "text" } })).toHaveLength(0);

    // Comment without body
    expect(extractComments({ comment: { user: { login: "x" } } })).toHaveLength(0);

    // Comment without user
    expect(extractComments({ comment: { body: "text" } })).toHaveLength(0);
  });
});

// ── formatReviewPrompt ───────────────────────────────────────────────────────

describe("formatReviewPrompt", () => {
  it("includes PR number and title", () => {
    const result = formatReviewPrompt("Fix login bug", 123, [
      { author: "alice", body: "Please add tests" },
    ]);
    expect(result).toContain("#123");
    expect(result).toContain("Fix login bug");
  });

  it("formats line comments with path:line", () => {
    const result = formatReviewPrompt("Refactor", 456, [
      { author: "bob", body: "Use const here", path: "src/app.ts", line: 10 },
    ]);
    expect(result).toContain("`src/app.ts:10`");
    expect(result).toContain("bob");
    expect(result).toContain("Use const here");
  });

  it("includes review state when provided", () => {
    const result = formatReviewPrompt("Feature", 789, [
      { author: "carol", body: "Needs work" },
    ], "changes_requested");
    expect(result).toContain("changes_requested");
  });

  it("formats path-only comments without line number", () => {
    const result = formatReviewPrompt("PR", 1, [
      { author: "dave", body: "Check this file", path: "README.md" },
    ]);
    expect(result).toContain("`README.md`");
    expect(result).not.toContain("undefined");
  });
});

// ── findSessionByPR ──────────────────────────────────────────────────────────

describe("findSessionByPR", () => {
  it("returns session matching pr_url", () => {
    const session = createSession({ summary: "test session" });
    updateSession(session.id, { pr_url: "https://github.com/org/repo/pull/42" });

    const found = findSessionByPR("https://github.com/org/repo/pull/42");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(session.id);
    expect(found!.pr_url).toBe("https://github.com/org/repo/pull/42");
  });

  it("returns null for unknown PR", () => {
    const found = findSessionByPR("https://github.com/org/repo/pull/999");
    expect(found).toBeNull();
  });

  it("returns most recent session for same PR", () => {
    const prUrl = "https://github.com/org/repo/pull/77";

    const older = createSession({ summary: "older" });
    updateSession(older.id, { pr_url: prUrl });

    // Small delay to ensure different created_at
    const newer = createSession({ summary: "newer" });
    updateSession(newer.id, { pr_url: prUrl });

    const found = findSessionByPR(prUrl);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(newer.id);
    expect(found!.summary).toBe("newer");
  });
});

// ── handleGitHubWebhook ──────────────────────────────────────────────────────

describe("handleGitHubWebhook", () => {
  function makePRPayload(prUrl: string, overrides?: Record<string, any>) {
    return {
      pull_request: {
        html_url: prUrl,
        title: "Test PR",
        number: 42,
      },
      ...overrides,
    };
  }

  it("returns approve for approved reviews with matching session", () => {
    const prUrl = "https://github.com/org/repo/pull/10";
    const session = createSession({ summary: "webhook test" });
    updateSession(session.id, { pr_url: prUrl, status: "running" });

    const result = handleGitHubWebhook("pull_request_review", makePRPayload(prUrl, {
      review: {
        state: "approved",
        body: "LGTM",
        user: { login: "approver" },
      },
    }));

    expect(result.action).toBe("approve");
    expect(result.sessionId).toBe(session.id);
  });

  it("returns steer for changes_requested with comments", () => {
    const prUrl = "https://github.com/org/repo/pull/20";
    const session = createSession({ summary: "steer test" });
    updateSession(session.id, { pr_url: prUrl, status: "stopped" });

    const result = handleGitHubWebhook("pull_request_review", makePRPayload(prUrl, {
      review: {
        state: "changes_requested",
        body: "Fix the error handling",
        user: { login: "reviewer" },
      },
    }));

    expect(result.action).toBe("steer");
    expect(result.sessionId).toBe(session.id);
    expect(result.message).toContain("Fix the error handling");
  });

  it("returns steer for pull_request_review_comment", () => {
    const prUrl = "https://github.com/org/repo/pull/30";
    const session = createSession({ summary: "comment test" });
    updateSession(session.id, { pr_url: prUrl, status: "running" });

    const result = handleGitHubWebhook("pull_request_review_comment", makePRPayload(prUrl, {
      comment: {
        body: "Use a map here instead",
        user: { login: "commenter" },
        path: "src/utils.ts",
        line: 55,
      },
    }));

    expect(result.action).toBe("steer");
    expect(result.sessionId).toBe(session.id);
    expect(result.message).toContain("Use a map here instead");
    expect(result.message).toContain("src/utils.ts:55");
  });

  it("ignores unknown event types", () => {
    const result = handleGitHubWebhook("push", { ref: "refs/heads/main" });
    expect(result.action).toBe("ignore");
  });

  it("ignores events without PR URL", () => {
    const result = handleGitHubWebhook("pull_request_review", {
      review: { state: "approved", body: "ok", user: { login: "x" } },
    });
    expect(result.action).toBe("ignore");
    expect(result.message).toContain("No PR URL");
  });

  it("ignores events with no matching session", () => {
    const result = handleGitHubWebhook("pull_request_review", makePRPayload(
      "https://github.com/org/repo/pull/9999",
      { review: { state: "approved", body: "ok", user: { login: "x" } } },
    ));
    expect(result.action).toBe("ignore");
    expect(result.message).toContain("No session");
  });
});

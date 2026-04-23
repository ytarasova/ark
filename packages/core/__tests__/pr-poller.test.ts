/**
 * Tests for pull-based PR monitoring (pr-poller.ts).
 *
 * Mocks child_process.execFile to simulate `gh pr view` output.
 * Uses real store with test isolation for session/event verification.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";

// ── Mock gh exec via setGhExec ───────────────────────────────────────────────

let execFileResult: { stdout: string; stderr: string } = { stdout: "{}", stderr: "" };
let execFileShouldThrow = false;

import {
  pollPRReviews,
  checkSessionPR,
  fetchPRReviews,
  processReviewFeedback,
  setGhExec,
} from "../integrations/pr-poller.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

// ── Test setup ───────────────────────────────────────────────────────────────

withTestContext();

const flowDir = () => join(getApp().config.dirs.ark, "flows");

function writeUserFlow(name: string, def: Record<string, unknown>): void {
  const dir = flowDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(def));
}

function makeGhOutput(overrides: Record<string, any> = {}): string {
  return JSON.stringify({
    title: "Test PR",
    number: 42,
    state: "OPEN",
    reviews: [],
    ...overrides,
  });
}

async function createReviewSession(
  opts: { pr_url?: string; status?: string; flow?: string; stage?: string; config?: Record<string, any> } = {},
): Promise<any> {
  const session = await getApp().sessions.create({
    summary: "test pr poller",
    flow: opts.flow ?? "review-flow",
  });
  await getApp().sessions.update(session.id, {
    pr_url: opts.pr_url ?? "https://github.com/org/repo/pull/42",
    status: opts.status ?? "running",
    stage: opts.stage ?? "review",
    config: opts.config ?? {},
  });
  return (await getApp().sessions.get(session.id))!;
}

beforeEach(() => {
  rmSync(flowDir(), { recursive: true, force: true });

  // Write a flow with a review-gated stage
  writeUserFlow("review-flow", {
    name: "review-flow",
    stages: [
      { name: "implement", agent: "implementer", gate: "auto" },
      { name: "review", agent: "reviewer", gate: "review" },
      { name: "deploy", agent: "deployer", gate: "auto" },
    ],
  });

  // Reset mocks
  execFileResult = { stdout: makeGhOutput(), stderr: "" };
  execFileShouldThrow = false;

  // Wire up mock gh exec
  setGhExec(async (_args: string[]) => {
    if (execFileShouldThrow) throw new Error("gh CLI error");
    return { stdout: execFileResult.stdout };
  });
});

// ── pollPRReviews ────────────────────────────────────────────────────────────

describe("pollPRReviews", async () => {
  it("skips sessions without pr_url", async () => {
    const session = await getApp().sessions.create({ summary: "no pr", flow: "review-flow" });
    await getApp().sessions.update(session.id, { status: "running", stage: "review" });
    // No pr_url set

    await pollPRReviews(getApp());

    // Should not have created any pr_ events
    const events = await getApp().events.list(session.id);
    const prEvents = events.filter((e) => e.type.startsWith("pr_"));
    expect(prEvents).toHaveLength(0);
  });

  it("skips sessions not in review-gated stage", async () => {
    const session = await getApp().sessions.create({ summary: "wrong stage", flow: "review-flow" });
    await getApp().sessions.update(session.id, {
      pr_url: "https://github.com/org/repo/pull/99",
      status: "running",
      stage: "implement", // auto gate, not review
    });

    await pollPRReviews(getApp());

    const events = await getApp().events.list(session.id);
    const prEvents = events.filter((e) => e.type.startsWith("pr_"));
    expect(prEvents).toHaveLength(0);
  });

  it("respects 60-second cooldown", async () => {
    const session = await createReviewSession({
      config: {
        last_review_check: new Date().toISOString(), // just checked
      },
    });

    execFileResult = {
      stdout: makeGhOutput({
        reviews: [{ author: { login: "alice" }, body: "LGTM", state: "APPROVED", submittedAt: "2026-03-27T12:00:00Z" }],
      }),
      stderr: "",
    };

    await pollPRReviews(getApp());

    // Should have been skipped due to cooldown - no pr_approved event
    const events = await getApp().events.list(session.id);
    const approvals = events.filter((e) => e.type === "pr_approved");
    expect(approvals).toHaveLength(0);
  });
});

// ── checkSessionPR ───────────────────────────────────────────────────────────

describe("checkSessionPR", async () => {
  it("detects new approval and logs pr_approved event", async () => {
    const session = await createReviewSession();

    execFileResult = {
      stdout: makeGhOutput({
        reviews: [{ author: { login: "alice" }, body: "LGTM", state: "APPROVED", submittedAt: "2026-03-27T12:00:00Z" }],
      }),
      stderr: "",
    };

    await checkSessionPR(getApp(), session);

    const events = await getApp().events.list(session.id);
    const approvals = events.filter((e) => e.type === "pr_approved");
    expect(approvals).toHaveLength(1);

    const eventData = approvals[0].data as Record<string, any>;
    expect(eventData.reviewers).toContain("alice");
  });

  it("detects changes_requested and stores feedback message", async () => {
    const session = await createReviewSession();

    execFileResult = {
      stdout: makeGhOutput({
        reviews: [
          {
            author: { login: "bob" },
            body: "Fix the error handling",
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-03-27T12:00:00Z",
          },
        ],
      }),
      stderr: "",
    };

    await checkSessionPR(getApp(), session);

    // Should have logged pr_review_feedback event
    const events = await getApp().events.list(session.id);
    const feedback = events.filter((e) => e.type === "pr_review_feedback");
    expect(feedback).toHaveLength(1);

    // Should have stored a message
    const messages = await getApp().messages.list(session.id);
    const systemMsgs = messages.filter((m) => m.role === "system");
    expect(systemMsgs.length).toBeGreaterThanOrEqual(1);
    expect(systemMsgs[systemMsgs.length - 1].content).toContain("Fix the error handling");
  });

  it("handles gh CLI errors gracefully", async () => {
    const session = await createReviewSession();
    execFileShouldThrow = true;

    // Should not throw
    await checkSessionPR(getApp(), session);

    // No events should have been created
    const events = await getApp().events.list(session.id);
    const prEvents = events.filter((e) => e.type.startsWith("pr_"));
    expect(prEvents).toHaveLength(0);
  });

  it("handles empty reviews array", async () => {
    const session = await createReviewSession();
    execFileResult = { stdout: makeGhOutput({ reviews: [] }), stderr: "" };

    await checkSessionPR(getApp(), session);

    // Only timestamp update, no review events
    const events = await getApp().events.list(session.id);
    const prEvents = events.filter((e) => e.type.startsWith("pr_"));
    expect(prEvents).toHaveLength(0);
  });

  it("logs pr_status event when PR is merged", async () => {
    const session = await createReviewSession();
    execFileResult = { stdout: makeGhOutput({ state: "MERGED", reviews: [] }), stderr: "" };

    await checkSessionPR(getApp(), session);

    const events = await getApp().events.list(session.id);
    const statusEvents = events.filter((e) => e.type === "pr_status");
    expect(statusEvents).toHaveLength(1);

    const eventData = statusEvents[0].data as Record<string, any>;
    expect(eventData.state).toBe("MERGED");
  });

  it("skips already-seen reviews based on review_count", async () => {
    const session = await createReviewSession({
      config: {
        review_count: 1,
        last_review_time: "2026-03-27T11:00:00Z",
      },
    });

    // Same single review that was already counted
    execFileResult = {
      stdout: makeGhOutput({
        reviews: [{ author: { login: "alice" }, body: "LGTM", state: "APPROVED", submittedAt: "2026-03-27T11:00:00Z" }],
      }),
      stderr: "",
    };

    await checkSessionPR(getApp(), session);

    // Should not create pr_approved because review_count hasn't increased
    const events = await getApp().events.list(session.id);
    const approvals = events.filter((e) => e.type === "pr_approved");
    expect(approvals).toHaveLength(0);
  });
});

// ── fetchPRReviews ──────────────────────────────────────────────────────────

describe("fetchPRReviews", async () => {
  it("parses PR data from gh CLI output", async () => {
    const mockExec = async () => ({
      stdout: JSON.stringify({
        title: "My PR",
        number: 99,
        state: "OPEN",
        reviews: [{ author: { login: "alice" }, body: "LGTM", state: "APPROVED", submittedAt: "2026-03-27T12:00:00Z" }],
      }),
    });

    const result = await fetchPRReviews("https://github.com/org/repo/pull/99", mockExec);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("My PR");
    expect(result!.number).toBe(99);
    expect(result!.reviews).toHaveLength(1);
    expect(result!.reviews[0].author.login).toBe("alice");
  });

  it("returns null on gh CLI failure", async () => {
    const mockExec = async () => {
      throw new Error("not found");
    };
    const result = await fetchPRReviews("https://github.com/org/repo/pull/404", mockExec);
    expect(result).toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    const mockExec = async () => ({ stdout: "not json" });
    const result = await fetchPRReviews("https://github.com/org/repo/pull/1", mockExec);
    expect(result).toBeNull();
  });
});

// ── processReviewFeedback ───────────────────────────────────────────────────

describe("processReviewFeedback", async () => {
  it("skips when no new reviews detected", async () => {
    const session = await createReviewSession();
    const config = { review_count: 1, last_review_time: "2026-03-27T12:00:00Z" };
    const data = {
      title: "PR",
      number: 42,
      state: "OPEN",
      reviews: [{ author: { login: "alice" }, body: "LGTM", state: "APPROVED", submittedAt: "2026-03-27T12:00:00Z" }],
    };

    await processReviewFeedback(getApp(), session, data, config);

    const events = await getApp().events.list(session.id);
    const prEvents = events.filter((e) => e.type.startsWith("pr_"));
    expect(prEvents).toHaveLength(0);
  });

  it("logs pr_approved event for new approval", async () => {
    const session = await createReviewSession();
    const config = { review_count: 0, last_review_time: "" };
    const data = {
      title: "PR",
      number: 42,
      state: "OPEN",
      reviews: [{ author: { login: "alice" }, body: "LGTM", state: "APPROVED", submittedAt: "2026-03-27T12:00:00Z" }],
    };

    await processReviewFeedback(getApp(), session, data, config);

    const events = await getApp().events.list(session.id);
    const approvals = events.filter((e) => e.type === "pr_approved");
    expect(approvals).toHaveLength(1);
  });

  it("stores feedback message for changes_requested", async () => {
    const session = await createReviewSession({ status: "blocked" });
    const config = { review_count: 0, last_review_time: "" };
    const data = {
      title: "Fix bug",
      number: 42,
      state: "OPEN",
      reviews: [
        {
          author: { login: "bob" },
          body: "Needs rework",
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-03-27T12:00:00Z",
        },
      ],
    };

    await processReviewFeedback(getApp(), session, data, config);

    const events = await getApp().events.list(session.id);
    const feedback = events.filter((e) => e.type === "pr_review_feedback");
    expect(feedback).toHaveLength(1);

    // Should have stored a message
    const messages = await getApp().messages.list(session.id);
    const systemMsgs = messages.filter((m) => m.role === "system");
    expect(systemMsgs.length).toBeGreaterThanOrEqual(1);
  });

  it("updates session config with review count", async () => {
    const session = await createReviewSession();
    const config = { review_count: 0, last_review_time: "" };
    const data = {
      title: "PR",
      number: 42,
      state: "OPEN",
      reviews: [{ author: { login: "alice" }, body: "ok", state: "APPROVED", submittedAt: "2026-03-27T12:00:00Z" }],
    };

    await processReviewFeedback(getApp(), session, data, config);

    const updated = (await getApp().sessions.get(session.id))!;
    const updatedConfig = updated.config as Record<string, any>;
    expect(updatedConfig.review_count).toBe(1);
  });
});

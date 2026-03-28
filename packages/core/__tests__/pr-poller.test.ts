/**
 * Tests for pull-based PR monitoring (pr-poller.ts).
 *
 * Mocks child_process.execFile to simulate `gh pr view` output.
 * Uses real store with test isolation for session/event verification.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";

// ── Mock gh exec via setGhExec ───────────────────────────────────────────────

let execFileResult: { stdout: string; stderr: string } = { stdout: "{}", stderr: "" };
let execFileShouldThrow = false;

import {
  createTestContext, setContext, resetContext,
  type TestContext,
} from "../context.js";
import { ARK_DIR } from "../store.js";
import * as store from "../store.js";
import { createSession } from "../store.js";
import { pollPRReviews, checkSessionPR, setGhExec } from "../pr-poller.js";

// ── Test setup ───────────────────────────────────────────────────────────────

let ctx: TestContext;

const flowDir = () => join(ARK_DIR(), "flows");

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

function createReviewSession(opts: { pr_url?: string; status?: string; flow?: string; stage?: string; config?: Record<string, any> } = {}): store.Session {
  const session = createSession({
    summary: "test pr poller",
    flow: opts.flow ?? "review-flow",
  });
  store.updateSession(session.id, {
    pr_url: opts.pr_url ?? "https://github.com/org/repo/pull/42",
    status: opts.status ?? "running",
    stage: opts.stage ?? "review",
    config: opts.config ?? {},
  });
  return store.getSession(session.id)!;
}

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
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

afterAll(() => {
  rmSync(flowDir(), { recursive: true, force: true });
  if (ctx) ctx.cleanup();
  resetContext();
});

// ── pollPRReviews ────────────────────────────────────────────────────────────

describe("pollPRReviews", () => {
  it("skips sessions without pr_url", async () => {
    const session = createSession({ summary: "no pr", flow: "review-flow" });
    store.updateSession(session.id, { status: "running", stage: "review" });
    // No pr_url set

    await pollPRReviews();

    // Should not have created any pr_ events
    const events = store.getEvents(session.id);
    const prEvents = events.filter(e => e.type.startsWith("pr_"));
    expect(prEvents).toHaveLength(0);
  });

  it("skips sessions not in review-gated stage", async () => {
    const session = createSession({ summary: "wrong stage", flow: "review-flow" });
    store.updateSession(session.id, {
      pr_url: "https://github.com/org/repo/pull/99",
      status: "running",
      stage: "implement", // auto gate, not review
    });

    await pollPRReviews();

    const events = store.getEvents(session.id);
    const prEvents = events.filter(e => e.type.startsWith("pr_"));
    expect(prEvents).toHaveLength(0);
  });

  it("respects 60-second cooldown", async () => {
    const session = createReviewSession({
      config: {
        last_review_check: new Date().toISOString(), // just checked
      },
    });

    execFileResult = { stdout: makeGhOutput({ reviews: [
      { author: { login: "alice" }, body: "LGTM", state: "APPROVED", submittedAt: "2026-03-27T12:00:00Z" },
    ]}), stderr: "" };

    await pollPRReviews();

    // Should have been skipped due to cooldown - no pr_approved event
    const events = store.getEvents(session.id);
    const approvals = events.filter(e => e.type === "pr_approved");
    expect(approvals).toHaveLength(0);
  });
});

// ── checkSessionPR ───────────────────────────────────────────────────────────

describe("checkSessionPR", () => {
  it("detects new approval and logs pr_approved event", async () => {
    const session = createReviewSession();

    execFileResult = { stdout: makeGhOutput({
      reviews: [
        { author: { login: "alice" }, body: "LGTM", state: "APPROVED", submittedAt: "2026-03-27T12:00:00Z" },
      ],
    }), stderr: "" };

    await checkSessionPR(session);

    const events = store.getEvents(session.id);
    const approvals = events.filter(e => e.type === "pr_approved");
    expect(approvals).toHaveLength(1);

    const eventData = approvals[0].data as Record<string, any>;
    expect(eventData.reviewers).toContain("alice");
  });

  it("detects changes_requested and stores feedback message", async () => {
    const session = createReviewSession();

    execFileResult = { stdout: makeGhOutput({
      reviews: [
        { author: { login: "bob" }, body: "Fix the error handling", state: "CHANGES_REQUESTED", submittedAt: "2026-03-27T12:00:00Z" },
      ],
    }), stderr: "" };

    await checkSessionPR(session);

    // Should have logged pr_review_feedback event
    const events = store.getEvents(session.id);
    const feedback = events.filter(e => e.type === "pr_review_feedback");
    expect(feedback).toHaveLength(1);

    // Should have stored a message
    const messages = store.getMessages(session.id);
    const systemMsgs = messages.filter(m => m.role === "system");
    expect(systemMsgs.length).toBeGreaterThanOrEqual(1);
    expect(systemMsgs[systemMsgs.length - 1].content).toContain("Fix the error handling");
  });

  it("handles gh CLI errors gracefully", async () => {
    const session = createReviewSession();
    execFileShouldThrow = true;

    // Should not throw
    await checkSessionPR(session);

    // No events should have been created
    const events = store.getEvents(session.id);
    const prEvents = events.filter(e => e.type.startsWith("pr_"));
    expect(prEvents).toHaveLength(0);
  });

  it("handles empty reviews array", async () => {
    const session = createReviewSession();
    execFileResult = { stdout: makeGhOutput({ reviews: [] }), stderr: "" };

    await checkSessionPR(session);

    // Only timestamp update, no review events
    const events = store.getEvents(session.id);
    const prEvents = events.filter(e => e.type.startsWith("pr_"));
    expect(prEvents).toHaveLength(0);
  });

  it("logs pr_status event when PR is merged", async () => {
    const session = createReviewSession();
    execFileResult = { stdout: makeGhOutput({ state: "MERGED", reviews: [] }), stderr: "" };

    await checkSessionPR(session);

    const events = store.getEvents(session.id);
    const statusEvents = events.filter(e => e.type === "pr_status");
    expect(statusEvents).toHaveLength(1);

    const eventData = statusEvents[0].data as Record<string, any>;
    expect(eventData.state).toBe("MERGED");
  });

  it("skips already-seen reviews based on review_count", async () => {
    const session = createReviewSession({
      config: {
        review_count: 1,
        last_review_time: "2026-03-27T11:00:00Z",
      },
    });

    // Same single review that was already counted
    execFileResult = { stdout: makeGhOutput({
      reviews: [
        { author: { login: "alice" }, body: "LGTM", state: "APPROVED", submittedAt: "2026-03-27T11:00:00Z" },
      ],
    }), stderr: "" };

    await checkSessionPR(session);

    // Should not create pr_approved because review_count hasn't increased
    const events = store.getEvents(session.id);
    const approvals = events.filter(e => e.type === "pr_approved");
    expect(approvals).toHaveLength(0);
  });
});

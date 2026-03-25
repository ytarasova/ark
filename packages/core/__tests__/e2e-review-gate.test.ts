/**
 * E2E tests for the review gate + GitHub webhook flow.
 *
 * Tests the full pipeline: conductor starts, webhook endpoint receives
 * GitHub PR review events, validates HMAC, routes to the correct session,
 * and either approves the review gate or steers the agent.
 */

import { createHmac } from "crypto";
import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import YAML from "yaml";

import {
  createTestContext, setContext, resetContext,
  updateSession, getEvents, listSessions,
  type TestContext,
} from "../index.js";
import { createSession } from "../store.js";
import * as store from "../store.js";
import { startConductor } from "../conductor.js";
import { startSession, approveReviewGate } from "../session.js";
import { ARK_DIR } from "../store.js";

const TEST_PORT = 19201;
const TEST_SECRET = "test-secret";

let ctx: TestContext;
let server: { stop(): void };

function sign(body: string, secret: string = TEST_SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

async function postWebhook(
  body: string,
  opts: { event?: string; signature?: string } = {},
): Promise<Response> {
  const event = opts.event ?? "pull_request_review";
  const signature = opts.signature ?? sign(body);
  return fetch(`http://localhost:${TEST_PORT}/api/webhook/github`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": signature,
    },
    body,
  });
}

const flowDir = () => join(ARK_DIR(), "flows");

function writeUserFlow(name: string, def: Record<string, unknown>): void {
  const dir = flowDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(def));
}

function makeReviewPayload(prUrl: string, overrides?: Record<string, any>): Record<string, any> {
  return {
    pull_request: {
      html_url: prUrl,
      title: "Test PR",
      number: 42,
    },
    ...overrides,
  };
}

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
  process.env.ARK_GITHUB_WEBHOOK_SECRET = TEST_SECRET;
  server = startConductor(TEST_PORT, { quiet: true });
});

afterEach(() => {
  try { server.stop(); } catch {}
  delete process.env.ARK_GITHUB_WEBHOOK_SECRET;
  rmSync(flowDir(), { recursive: true, force: true });
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

// ── Test 1: Full review gate flow ──────────────────────────────────────────

describe("E2E review gate flow", () => {
  it("approved webhook advances session past review gate", async () => {
    writeUserFlow("review-e2e", {
      name: "review-e2e",
      stages: [
        { name: "code", agent: "implementer", gate: "auto" },
        { name: "wait-review", agent: "reviewer", gate: "review" },
        { name: "deploy", agent: "deployer", gate: "auto" },
      ],
    });

    const prUrl = "https://github.com/org/repo/pull/42";
    const session = startSession({ flow: "review-e2e", summary: "review e2e test" });
    updateSession(session.id, { pr_url: prUrl, status: "waiting", stage: "wait-review" });

    const body = JSON.stringify(makeReviewPayload(prUrl, {
      review: {
        state: "approved",
        body: "LGTM",
        user: { login: "reviewer1" },
      },
    }));

    const resp = await postWebhook(body);
    expect(resp.status).toBe(200);

    const result = await resp.json();
    expect(result.action).toBe("approve");
    expect(result.sessionId).toBe(session.id);

    // Verify approve event was logged
    const events = getEvents(session.id, { type: "webhook_review_approved" });
    expect(events.length).toBe(1);
    expect(events[0].actor).toBe("github");
  });

  // ── Test 2: Changes requested steers agent ──────────────────────────────

  it("changes_requested webhook steers agent with comments", async () => {
    const prUrl = "https://github.com/org/repo/pull/55";
    const session = createSession({ summary: "steer e2e test" });
    updateSession(session.id, { pr_url: prUrl, status: "running" });

    const body = JSON.stringify(makeReviewPayload(prUrl, {
      review: {
        state: "changes_requested",
        body: "Fix the error handling in auth.ts",
        user: { login: "lead-dev" },
      },
    }));

    const resp = await postWebhook(body);
    expect(resp.status).toBe(200);

    const result = await resp.json();
    expect(result.action).toBe("steer");
    expect(result.sessionId).toBe(session.id);
    expect(result.message).toContain("Fix the error handling in auth.ts");

    // Verify steer event was logged
    const events = getEvents(session.id, { type: "webhook_review_steer" });
    expect(events.length).toBe(1);
    expect(events[0].actor).toBe("github");
  });

  // ── Test 3: HMAC rejects bad signature ──────────────────────────────────

  it("rejects webhook with invalid HMAC signature", async () => {
    const body = JSON.stringify(makeReviewPayload("https://github.com/org/repo/pull/1"));

    const resp = await postWebhook(body, { signature: "sha256=bad" });
    expect(resp.status).toBe(401);

    const result = await resp.json();
    expect(result.error).toContain("invalid signature");
  });

  // ── Test 4: Missing secret returns 500 ──────────────────────────────────

  it("returns 500 when ARK_GITHUB_WEBHOOK_SECRET is not set", async () => {
    delete process.env.ARK_GITHUB_WEBHOOK_SECRET;

    const body = JSON.stringify(makeReviewPayload("https://github.com/org/repo/pull/1"));

    const resp = await postWebhook(body);
    expect(resp.status).toBe(500);

    const result = await resp.json();
    expect(result.error).toContain("ARK_GITHUB_WEBHOOK_SECRET not set");
  });

  // ── Test 5: Unknown PR ignored ──────────────────────────────────────────

  it("ignores webhook for PR with no matching session", async () => {
    const body = JSON.stringify(makeReviewPayload("https://github.com/org/repo/pull/9999", {
      review: {
        state: "approved",
        body: "LGTM",
        user: { login: "reviewer" },
      },
    }));

    const resp = await postWebhook(body);
    expect(resp.status).toBe(200);

    const result = await resp.json();
    expect(result.action).toBe("ignore");
  });

  // ── Test 6: Multiple comments formatted ─────────────────────────────────

  it("multiple review comments all appear in logged event", async () => {
    const prUrl = "https://github.com/org/repo/pull/77";
    const session = createSession({ summary: "multi-comment test" });
    updateSession(session.id, { pr_url: prUrl, status: "running" });

    // Send review with body comment
    const body1 = JSON.stringify(makeReviewPayload(prUrl, {
      review: {
        state: "changes_requested",
        body: "Comment one: fix types",
        user: { login: "alice" },
      },
    }));

    const resp1 = await postWebhook(body1);
    expect(resp1.status).toBe(200);
    const result1 = await resp1.json();
    expect(result1.message).toContain("Comment one: fix types");

    // Send inline comment
    const body2 = JSON.stringify(makeReviewPayload(prUrl, {
      comment: {
        body: "Comment two: use const",
        user: { login: "bob" },
        path: "src/utils.ts",
        line: 10,
      },
    }));

    const resp2 = await postWebhook(body2, { event: "pull_request_review_comment" });
    expect(resp2.status).toBe(200);
    const result2 = await resp2.json();
    expect(result2.message).toContain("Comment two: use const");
    expect(result2.message).toContain("src/utils.ts:10");

    // Send another inline comment
    const body3 = JSON.stringify(makeReviewPayload(prUrl, {
      comment: {
        body: "Comment three: add error handling",
        user: { login: "carol" },
        path: "src/auth.ts",
        line: 25,
      },
    }));

    const resp3 = await postWebhook(body3, { event: "pull_request_review_comment" });
    expect(resp3.status).toBe(200);
    const result3 = await resp3.json();
    expect(result3.message).toContain("Comment three: add error handling");

    // Verify all steer events were logged
    const events = getEvents(session.id, { type: "webhook_review_steer" });
    expect(events.length).toBe(3);
  });
});

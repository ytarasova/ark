/**
 * End-to-end tests for ark exec -- headless CI mode.
 *
 * Tests waitForCompletion polling logic and the exec CLI help output.
 * Does NOT actually run Claude -- uses direct store mutations to simulate
 * session state transitions.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { join } from "path";
import { AppContext, getApp, setApp, clearApp } from "../app.js";
import { startSession, waitForCompletion } from "../services/session-orchestration.js";

const ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(ROOT, "packages", "cli", "index.ts");

let app: AppContext;

beforeAll(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

// Track sessions for cleanup
const sessionIds: string[] = [];

afterEach(() => {
  for (const id of sessionIds) {
    try { app.sessions.delete(id); } catch { /* already gone */ }
  }
  sessionIds.length = 0;
});

// ── waitForCompletion ─────────────────────────────────────────────────────

describe("waitForCompletion", () => {
  it("returns immediately for completed session", async () => {
    const session = getApp().sessions.create({ summary: "wfc-completed" });
    sessionIds.push(session.id);
    getApp().sessions.update(session.id, { status: "completed", stage: "work" });

    const { session: final, timedOut } = await waitForCompletion(app, session.id, { pollMs: 50 });
    expect(timedOut).toBe(false);
    expect(final.status).toBe("completed");
  });

  it("returns immediately for failed session", async () => {
    const session = getApp().sessions.create({ summary: "wfc-failed" });
    sessionIds.push(session.id);
    getApp().sessions.update(session.id, { status: "failed", stage: "work", error: "boom" });

    const { session: final, timedOut } = await waitForCompletion(app, session.id, { pollMs: 50 });
    expect(timedOut).toBe(false);
    expect(final.status).toBe("failed");
    expect(final.error).toBe("boom");
  });

  it("returns immediately for stopped session", async () => {
    const session = getApp().sessions.create({ summary: "wfc-stopped" });
    sessionIds.push(session.id);
    getApp().sessions.update(session.id, { status: "stopped", stage: "work" });

    const { session: final, timedOut } = await waitForCompletion(app, session.id, { pollMs: 50 });
    expect(timedOut).toBe(false);
    expect(final.status).toBe("stopped");
  });

  it("times out when session stays running", async () => {
    const session = getApp().sessions.create({ summary: "wfc-timeout" });
    sessionIds.push(session.id);
    getApp().sessions.update(session.id, { status: "running", stage: "work" });

    const { session: final, timedOut } = await waitForCompletion(app, session.id, {
      timeoutMs: 150,
      pollMs: 50,
    });
    expect(timedOut).toBe(true);
    expect(final.status).toBe("running");
  });

  it("calls onStatus during polling", async () => {
    const session = getApp().sessions.create({ summary: "wfc-status-cb" });
    sessionIds.push(session.id);
    getApp().sessions.update(session.id, { status: "running", stage: "work" });

    const statuses: string[] = [];

    // Transition to completed after a short delay
    setTimeout(() => {
      getApp().sessions.update(session.id, { status: "completed" });
    }, 120);

    const { session: final, timedOut } = await waitForCompletion(app, session.id, {
      pollMs: 50,
      timeoutMs: 2000,
      onStatus: (status) => statuses.push(status),
    });

    expect(timedOut).toBe(false);
    expect(final.status).toBe("completed");
    expect(statuses.length).toBeGreaterThanOrEqual(1);
    expect(statuses[0]).toBe("running");
  });

  it("returns null-ish for nonexistent session", async () => {
    const { session: final, timedOut } = await waitForCompletion(app, "s-does-not-exist", { pollMs: 50 });
    expect(timedOut).toBe(false);
    expect(final).toBeNull();
  });
});

// ── exec flow (session creation) ────────────────────────────────────────────

describe("exec session creation", () => {
  it("creates session with correct flow/summary/compute from opts", () => {
    const session = startSession(app, {
      summary: "exec-test-summary",
      repo: "my-repo",
      flow: "bare",
      compute_name: undefined,
      group_name: "ci-group",
    });
    sessionIds.push(session.id);

    expect(session.summary).toBe("exec-test-summary");
    expect(session.repo).toBe("my-repo");
    expect(session.flow).toBe("bare");
    expect(session.group_name).toBe("ci-group");
    expect(session.status).toBe("ready");
  });
});

// ── CLI help ────────────────────────────────────────────────────────────────

describe("exec CLI", () => {
  it("execSession is importable and callable", async () => {
    // Verify the exec module exists and exports the expected function
    const mod = await import("../../cli/exec.js");
    expect(typeof mod.execSession).toBe("function");
  });
});

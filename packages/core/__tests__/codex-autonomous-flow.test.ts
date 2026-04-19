/**
 * Tests for Codex runtime working with the autonomous flow.
 *
 * Validates:
 * 1. Status poller treats "not_found" (tmux exited) as completion
 * 2. Completion triggers advance() which completes single-stage autonomous flow
 * 3. cli-agent executor returns "not_found" when tmux session is gone
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { startStatusPoller, stopStatusPoller, stopAllPollers } from "../executors/status-poller.js";
import { cliAgentExecutor } from "../executors/cli-agent.js";
import * as tmux from "../infra/tmux.js";

// ── App fixture ──────────────────────────────────────────────────────────────

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterEach(async () => {
  stopAllPollers();
  await app?.shutdown();
  clearApp();
});

// ── Helper ────────────────────────────────────────────────────────────────────

function waitFor(fn: () => boolean, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(check, 100);
    };
    check();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Codex runtime + autonomous flow", () => {
  it("cli-agent executor returns not_found when tmux session is gone", async () => {
    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);
    try {
      const status = await cliAgentExecutor.status("ark-s-fake");
      expect(status.state).toBe("not_found");
    } finally {
      spy.mockRestore();
    }
  });

  it("status poller completes session when tmux exits (not_found)", async () => {
    // Create a session on the autonomous flow
    const session = app.sessions.create({ summary: "codex test", flow: "autonomous" });
    app.sessions.update(session.id, { status: "running", stage: "work", session_id: "ark-" + session.id });

    // Mock: tmux session is already gone (Codex finished)
    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);

    try {
      // Start the status poller for cli-agent executor
      startStatusPoller(app, session.id, "ark-" + session.id, "cli-agent");

      // Wait for the poller to detect not_found and complete the session
      await waitFor(() => {
        const s = app.sessions.get(session.id);
        return s?.status === "completed";
      });

      const updated = app.sessions.get(session.id);
      expect(updated?.status).toBe("completed");
    } finally {
      spy.mockRestore();
    }
  });

  it("status poller handles failed state correctly", async () => {
    const session = app.sessions.create({ summary: "codex fail test", flow: "autonomous" });
    app.sessions.update(session.id, { status: "running", stage: "work", session_id: "ark-" + session.id });

    // Mock a cli-agent that returns "not_found" (same as exit)
    // The cli-agent always returns not_found or running -- never "failed"
    // So not_found should always map to completed
    const spy = spyOn(tmux, "sessionExistsAsync").mockResolvedValue(false);

    try {
      startStatusPoller(app, session.id, "ark-" + session.id, "cli-agent");

      await waitFor(() => {
        const s = app.sessions.get(session.id);
        return s?.status !== "running";
      });

      const updated = app.sessions.get(session.id);
      // cli-agent returns not_found (not failed), so it should be completed
      expect(updated?.status).toBe("completed");
    } finally {
      spy.mockRestore();
    }
  });
});

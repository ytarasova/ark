/**
 * applyHookStatus must not revive an archived session.
 *
 * Reproduced 2026-05-06 on the fleet: a session in `archived` status was
 * silently rewritten to `ready` ~7 minutes after archive with no daemon
 * restart and no `session_*` event in between -- only `hook_status` rows.
 * Root cause: the terminal-status guard in hook-status.ts checked
 * completed/failed/stopped but not archived. archive() does not wait for
 * the agent process to exit, so a claude-agent that outlives archive can
 * emit a late SessionEnd hook -- which the runtime status map translates
 * to `ready` -- and the missing archived branch let it land.
 *
 * The fix folds archived into the same terminal-no-revive guard as the
 * other three. This test guards the entire set so regressions for any of
 * them are caught.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../app.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  await app?.shutdown();
});

const TERMINAL_STATUSES = ["completed", "failed", "stopped", "archived"] as const;

describe("applyHookStatus terminal-status revival guard", () => {
  for (const terminal of TERMINAL_STATUSES) {
    it(`does not flip ${terminal} -> ready on a late SessionEnd hook`, async () => {
      const session = await app.sessions.create({ summary: `${terminal} revival guard`, flow: "quick" });
      await app.sessions.update(session.id, {
        session_id: `ark-s-${session.id}`,
        status: terminal,
        stage: "implement",
      });

      const fresh = await app.sessions.get(session.id);
      expect(fresh?.status).toBe(terminal);

      // Simulate a delayed SessionEnd from a still-running agent. The runtime
      // status map maps SessionEnd to "ready" when it carries a non-failure
      // payload; the guard must intercept and emit no status update.
      const result = await app.sessionHooks.applyHookStatus(fresh!, "SessionEnd", {
        stage: "implement",
        session_id: session.id,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      });

      // The result is allowed to carry a hook_status event for observability,
      // but it must NOT carry a status update that re-enters the active set.
      const statusUpdate = result.updates?.status;
      expect(statusUpdate).toBeUndefined();

      // And the row itself stays put.
      const after = await app.sessions.get(session.id);
      expect(after?.status).toBe(terminal);
    });
  }

  it("non-terminal statuses still receive normal status transitions", async () => {
    // Sanity: the guard must NOT also block legitimate transitions on
    // running/ready/waiting sessions -- only terminal ones.
    const session = await app.sessions.create({ summary: "non-terminal still transitions", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
    });

    const fresh = await app.sessions.get(session.id);
    const result = await app.sessionHooks.applyHookStatus(fresh!, "SessionEnd", {
      stage: "implement",
      session_id: session.id,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    // SessionEnd on a running session is a valid transition -- the guard
    // should NOT have suppressed it. Exact target depends on flow semantics
    // but it must be defined (a status update was produced) and not equal
    // to "running" (otherwise the hook had no effect).
    expect(result.updates?.status).toBeDefined();
    expect(result.updates?.status).not.toBe("running");
  });
});

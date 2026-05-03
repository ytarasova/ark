/**
 * applyHookStatus must use payload.stage (runtime-stamped) as the source
 * of truth for event attribution, NOT session.stage at log time.
 *
 * The pre-fix behaviour: every event the conductor logged in response to
 * a hook was tagged with whatever session.stage read at that instant.
 * When the state machine flapped (status-poller false-positive advanced
 * session.stage prematurely while the same agent kept emitting hooks),
 * historical events ended up tagged with the wrong stage.
 *
 * The fix: each runtime stamps the stage it was provisioned for onto
 * every hook payload. The conductor reads `payload.stage` and uses that
 * for event attribution. Session.stage is the fallback when the payload
 * doesn't carry one (legacy / non-stamping runtimes).
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

describe("applyHookStatus stage attribution (#435)", () => {
  it("stamps hook_status events with payload.stage even when session.stage has flapped", async () => {
    // Repro the bug: the conductor's view of session.stage is stale or
    // wrong (here: "merge"), but the agent emitting the hook knows it's
    // really still on "verify" and stamps that on its payload. The
    // event row must be tagged "verify", NOT "merge".
    const session = await app.sessions.create({ summary: "stage attribution test", flow: "quick" });
    await app.sessions.update(session.id, { status: "running", stage: "merge" });

    const fresh = await app.sessions.get(session.id);
    const result = await app.sessionHooks.applyHookStatus(fresh!, "Stop", {
      stage: "verify",
      session_id: session.id,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const hookStatusEvent = result.events?.find((e) => e.type === "hook_status");
    expect(hookStatusEvent).toBeTruthy();
    expect(hookStatusEvent?.opts?.stage).toBe("verify");
  });

  it("falls back to session.stage when the runtime did not stamp a stage", async () => {
    // Legacy / non-stamping runtimes (anything pre-fix or non-claude-agent)
    // omit `stage` from the payload. Attribution falls back to session.stage
    // -- this is the same as the old behaviour, so existing flows are
    // unaffected.
    const session = await app.sessions.create({ summary: "fallback test", flow: "quick" });
    await app.sessions.update(session.id, { status: "running", stage: "implement" });

    const fresh = await app.sessions.get(session.id);
    const result = await app.sessionHooks.applyHookStatus(fresh!, "Stop", {
      session_id: session.id,
      // no `stage` field
    });

    const hookStatusEvent = result.events?.find((e) => e.type === "hook_status");
    expect(hookStatusEvent).toBeTruthy();
    expect(hookStatusEvent?.opts?.stage).toBe("implement");
  });

  it("ignores empty-string stage and falls back to session.stage", async () => {
    // Empty payload.stage means "I am the legacy launcher and don't know
    // my stage" -- treated as absent.
    const session = await app.sessions.create({ summary: "empty stage test", flow: "quick" });
    await app.sessions.update(session.id, { status: "running", stage: "implement" });

    const fresh = await app.sessions.get(session.id);
    const result = await app.sessionHooks.applyHookStatus(fresh!, "Stop", {
      stage: "",
      session_id: session.id,
    });

    const hookStatusEvent = result.events?.find((e) => e.type === "hook_status");
    expect(hookStatusEvent?.opts?.stage).toBe("implement");
  });
});

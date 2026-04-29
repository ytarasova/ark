/**
 * Regression test: resuming a session whose current stage is an action
 * (e.g. a `create_pr` that failed once) must advance the flow after the
 * action re-runs successfully. Without this fix, the session sat at
 * `status=ready, stage=<action>` forever, even though the action
 * finished cleanly -- only a manual `ark session advance` would move it.
 *
 * The regular dispatch path (`dispatch-core.ts`) handles this via
 * `mediateStageHandoff` immediately after `executeAction` returns; the
 * resume path (`kickActionStage` in `services/session.ts`) used to
 * just run the action and return, skipping the handoff entirely.
 *
 * Uses the bundled `close` (`close_ticket`) action as the stage action
 * so the test doesn't depend on any external tool (no `gh`, no
 * network).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { AppContext } from "../app.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

describe("resume on an action stage auto-advances on success", () => {
  it("completes the flow after the action re-runs (no manual advance needed)", async () => {
    // Inline flow: a single action stage. When resumed with the
    // session's current stage pointing at this action, kickActionStage
    // should execute it AND advance the flow to completion.
    const inlineFlow = {
      name: "resume-action-test",
      stages: [{ name: "finalize", action: "close", gate: "auto" as const }],
    };

    const session = await app.sessionLifecycle.start({
      summary: "resume action advance",
      flow: inlineFlow as any,
    });

    // Simulate the post-failure state resume is designed to recover
    // from: stage is the action, status is `failed`.
    await app.sessions.update(session.id, { status: "failed", stage: "finalize", error: "previous run failed" });

    const resumeResult = await app.sessionService.resume(session.id);
    expect(resumeResult.ok).toBe(true);

    // Drain the background kickActionStage promise so we observe its
    // terminal effects rather than the mid-flight state.
    await app.sessionService.drainPendingDispatches();

    const final = await app.sessions.get(session.id);
    expect(final?.status).toBe("completed");

    // The action's event must have fired -- proves the action actually
    // ran on resume (not just a status flip somewhere else).
    const events = await app.events.list(session.id);
    const actionEv = events.find((e) => e.type === "action_executed" && (e.data as any)?.action === "close");
    expect(actionEv).toBeDefined();
  });
});

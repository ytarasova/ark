/**
 * Fork dispatch split.
 *
 * These routes used to pull `fork` / `fanOut` in via dynamic import to dodge
 * the cycle with fork-join.ts. With the class-based split we thread those in
 * as `DispatchDeps` callbacks so the body reads straight through without
 * runtime `await import`.
 *
 * Child-session dispatch is similarly threaded in as `dispatchChild` --
 * wired at the DispatchService composition layer to loop back through
 * `this.dispatch(childId)`.
 *
 * Note: the legacy `dispatchFanOut` method (for `type: fan_out` stages) was
 * removed in P2.0b. Callers migrated to `for_each + mode:spawn` (dispatch-foreach.ts).
 */

import type { DispatchDeps, DispatchResult } from "./types.js";
import type { StageDefinition } from "../flow.js";

export class FanOutDispatcher {
  constructor(
    private readonly deps: Pick<DispatchDeps, "sessions" | "events" | "extractSubtasks" | "fork" | "dispatchChild">,
  ) {}

  async dispatchFork(sessionId: string, stageDef: StageDefinition): Promise<DispatchResult> {
    // Read PLAN.md or use default subtasks
    const session = (await this.deps.sessions.get(sessionId))!;
    const subtasks = await this.deps.extractSubtasks(session);

    const children: string[] = [];
    const failures: string[] = [];
    const planned = subtasks.slice(0, stageDef.max_parallel ?? 4);
    for (const sub of planned) {
      const result = await this.deps.fork(sessionId, sub.task, { dispatch: true });
      if (result.ok === true) {
        children.push(result.sessionId);
      } else {
        // Surface the failed child reason. Without this the parent waits at
        // status=waiting forever (auto-join only fires once children complete,
        // but the children that "failed" never actually got created).
        const reason = result.message ?? "fork returned ok:false";
        failures.push(reason);
        await this.deps.events.log(sessionId, "fork_child_failed", {
          stage: session.stage,
          actor: "system",
          data: { task: sub.task, reason },
        });
      }
    }

    // Fork parents have no agent of their own; the handle is never probed
    // but satisfies the status-running-implies-session_id invariant (#435).
    await this.deps.sessions.update(sessionId, { status: "running", session_id: `parent-${sessionId}` });
    await this.deps.events.log(sessionId, "fork_started", {
      stage: session.stage,
      actor: "system",
      data: {
        children_count: children.length,
        children,
        failures_count: failures.length,
        failures,
      },
    });

    // Zero-children fan-out is a dispatch failure: the parent has nothing to
    // wait on, so the auto-join path never fires and the session sits at
    // `waiting` forever. Surface as ok:false so the caller (kickDispatch +
    // mediateStageHandoff) marks the session failed via markDispatchFailedShared.
    if (planned.length > 0 && children.length === 0) {
      return {
        ok: false,
        message: `All ${planned.length} fork children failed: ${failures.join("; ")}`,
      };
    }

    return {
      ok: true,
      launched: false,
      reason: "fork_parent",
      message: `Forked into ${children.length} sessions`,
    };
  }
}

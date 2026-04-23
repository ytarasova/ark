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
import type { StageDefinition } from "../../state/flow.js";

export class FanOutDispatcher {
  constructor(
    private readonly deps: Pick<DispatchDeps, "sessions" | "events" | "extractSubtasks" | "fork" | "dispatchChild">,
  ) {}

  async dispatchFork(sessionId: string, stageDef: StageDefinition): Promise<DispatchResult> {
    // Read PLAN.md or use default subtasks
    const session = (await this.deps.sessions.get(sessionId))!;
    const subtasks = await this.deps.extractSubtasks(session);

    const children: string[] = [];
    for (const sub of subtasks.slice(0, stageDef.max_parallel ?? 4)) {
      const result = await this.deps.fork(sessionId, sub.task, { dispatch: true });
      if (result.ok === true) children.push(result.sessionId);
    }

    await this.deps.sessions.update(sessionId, { status: "running" });
    await this.deps.events.log(sessionId, "fork_started", {
      stage: session.stage,
      actor: "system",
      data: { children_count: children.length, children },
    });

    return { ok: true, message: `Forked into ${children.length} sessions` };
  }
}

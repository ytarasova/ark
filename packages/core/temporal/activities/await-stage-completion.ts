import { Context } from "@temporalio/activity";
import type { StageCompletionResult } from "../types.js";
import type { OrchestrationDeps } from "../../services/deps.js";

let _deps: OrchestrationDeps | null = null;
export function injectDeps(deps: OrchestrationDeps): void {
  _deps = deps;
}
function deps(): OrchestrationDeps {
  if (!_deps) throw new Error("awaitStageCompletionActivity: deps not injected");
  return _deps;
}

/**
 * Poll the sessions table until the session reaches a terminal state.
 * Heartbeats every poll interval so the Temporal server knows the activity is alive.
 */
export async function awaitStageCompletionActivity(input: {
  sessionId: string;
  stageIdx: number;
  timeoutMs?: number;
}): Promise<StageCompletionResult> {
  const d = deps();
  const deadline = Date.now() + (input.timeoutMs ?? 3_600_000);

  while (Date.now() < deadline) {
    Context.current().heartbeat(`waiting-stage-${input.stageIdx}`);

    const session = await d.sessions.get(input.sessionId);
    if (!session) {
      await Bun.sleep(2000);
      continue;
    }

    const status = session.status as string;
    if (["completed", "failed", "stopped", "archived"].includes(status)) {
      // Map archived -> stopped for the workflow's state machine.
      const mapped: StageCompletionResult["status"] =
        status === "archived" ? "stopped" : (status as StageCompletionResult["status"]);
      return { status: mapped };
    }

    await Bun.sleep(5000);
  }

  return { status: "failed", error: "awaitStageCompletion timed out" };
}

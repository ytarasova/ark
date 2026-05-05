/**
 * Task assembly for the main agent dispatch path.
 *
 * Builds the final task prompt that goes to the agent:
 *   1. buildTask (handoff context baked in)
 *   2. append rework prompt when gate/reject set one
 *   3. log prompt_sent event for audit
 *
 * Returns the fully assembled task plus a short preview captured before the
 * rework-prompt append so event consumers see the clean user task.
 */

import type { DispatchDeps } from "./types.js";
import type { Session } from "../../../types/index.js";

export interface AssembledTask {
  task: string;
  taskPreview: string;
}

export async function assembleTask(
  deps: Pick<DispatchDeps, "buildTask" | "events">,
  session: Session,
  stage: string,
  agentName: string,
  log: (msg: string) => void,
): Promise<AssembledTask> {
  log("Building task...");
  let task = await deps.buildTask(session, stage, agentName);
  const taskPreview = (session.summary || task.slice(0, 200)).slice(0, 200);

  // Append rework prompt (set by gate/reject). Single-shot: cleared after a
  // successful launch so subsequent dispatches of the same stage don't replay
  // stale rework instructions.
  const reworkPrompt = session.rework_prompt;
  if (reworkPrompt) {
    task += `\n\n## Rework requested\n\n${reworkPrompt}`;
    log(`Appended rework prompt (rejection #${session.rejection_count ?? 0})`);
  }

  await deps.events.log(session.id, "prompt_sent", {
    stage,
    actor: "orchestrator",
    data: {
      agent: agentName,
      task_preview: task.slice(0, 500),
      task_length: task.length,
      task_full: task,
    },
  });

  return { task, taskPreview };
}

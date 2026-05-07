import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import type * as acts from "../activities/index.js";
import type { StageWorkflowInput } from "../types.js";

const { dispatchStageActivity, awaitStageCompletionActivity, projectStageActivity } = proxyActivities<typeof acts>({
  startToCloseTimeout: "1 hour",
  heartbeatTimeout: "60 seconds",
  retry: { maximumAttempts: 3, initialInterval: "1s", backoffCoefficient: 2 },
});

export async function stageWorkflow(input: StageWorkflowInput): Promise<{ outcome: string; sessionId: string }> {
  const seq = () => workflowInfo().historyLength;

  const launch = await dispatchStageActivity({ sessionId: input.childSessionId, stageIdx: 0 });
  await projectStageActivity({
    sessionId: input.childSessionId,
    stageIdx: 0,
    seq: seq(),
    patch: { status: "running", ...launch },
  });

  const result = await awaitStageCompletionActivity({ sessionId: input.childSessionId, stageIdx: 0 });
  await projectStageActivity({
    sessionId: input.childSessionId,
    stageIdx: 0,
    seq: seq(),
    patch: { status: result.status },
  });

  return { outcome: result.status, sessionId: input.childSessionId };
}

import { proxyActivities, defineSignal, setHandler, workflowInfo } from "@temporalio/workflow";
import type * as acts from "../activities/index.js";
import type { SessionWorkflowInput } from "../types.js";

const {
  startSessionActivity,
  resolveComputeForStageActivity,
  provisionComputeActivity,
  dispatchStageActivity,
  awaitStageCompletionActivity,
  executeActionActivity: _executeActionActivity,
  runVerificationActivity: _runVerificationActivity,
  projectSessionActivity,
  projectStageActivity,
} = proxyActivities<typeof acts>({
  startToCloseTimeout: "1 hour",
  heartbeatTimeout: "60 seconds",
  retry: { maximumAttempts: 3, initialInterval: "1s", backoffCoefficient: 2 },
});

export const approveReviewGateSignal = defineSignal<[{ sessionId: string }]>("approveReviewGate");
export const rejectReviewGateSignal = defineSignal<[{ sessionId: string; reason: string }]>("rejectReviewGate");

export async function sessionWorkflow(input: SessionWorkflowInput): Promise<void> {
  let _reviewApproved = false;
  let _reviewRejected = false;

  setHandler(approveReviewGateSignal, () => {
    _reviewApproved = true;
  });
  setHandler(rejectReviewGateSignal, () => {
    _reviewRejected = true;
  });

  const seq = () => workflowInfo().historyLength;

  await startSessionActivity(input);
  await projectSessionActivity({ sessionId: input.sessionId, seq: seq(), patch: { status: "ready" } });

  // Iterate up to 20 stages. Each iteration:
  // 1. Resolve compute
  // 2. Provision (heartbeating, long-running)
  // 3. Dispatch the stage
  // 4. Await completion (heartbeating, long-running)
  // 5. Project result
  // 6. If stage failed/stopped, break
  // 7. If session is now terminal (all stages done), break
  for (let stageIdx = 0; stageIdx < 20; stageIdx++) {
    await resolveComputeForStageActivity({ sessionId: input.sessionId, stageIdx });
    await provisionComputeActivity({ sessionId: input.sessionId, computeName: "local" });
    await projectStageActivity({
      sessionId: input.sessionId,
      stageIdx,
      seq: seq(),
      patch: { status: "dispatching" },
    });

    const launch = await dispatchStageActivity({ sessionId: input.sessionId, stageIdx });
    await projectStageActivity({
      sessionId: input.sessionId,
      stageIdx,
      seq: seq(),
      patch: { status: "running", ...launch },
    });

    const result = await awaitStageCompletionActivity({
      sessionId: input.sessionId,
      stageIdx,
      timeoutMs: 3_600_000,
    });
    await projectStageActivity({
      sessionId: input.sessionId,
      stageIdx,
      seq: seq(),
      patch: { status: result.status },
    });

    if (result.status !== "completed") break;
    if (result.outcome === "session_complete") break;
  }

  await projectSessionActivity({
    sessionId: input.sessionId,
    seq: seq(),
    patch: { status: "completed" },
  });
}

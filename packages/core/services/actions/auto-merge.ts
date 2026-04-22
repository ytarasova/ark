import type { ActionHandler } from "./types.js";
import { mergeWorktreePR } from "../workspace-service.js";

/**
 * `auto_merge` -- queue the session's PR for merge via `gh pr merge --auto`.
 * After queueing, transition the session to `waiting`; `pr-merge-poller`
 * watches GitHub and advances once CI passes and the PR is merged.
 */
export const autoMergeAction: ActionHandler = {
  name: "auto_merge",
  async execute(app, session, action, _opts) {
    const sessionId = session.id;
    const result = await mergeWorktreePR(app, sessionId);
    if (!result.ok) return result;

    await app.events.log(sessionId, "action_executed", {
      stage: session.stage ?? undefined,
      actor: "system",
      data: { action, pr_url: session.pr_url ?? undefined },
    });

    // Transition to waiting; pr-merge-poller advances once CI passes + PR merges.
    await app.sessions.update(sessionId, {
      status: "waiting",
      breakpoint_reason: "Waiting for CI checks to pass and PR to merge",
      config: {
        ...(session.config ?? {}),
        merge_queued_at: new Date().toISOString(),
      },
    });
    await app.events.log(sessionId, "merge_waiting", {
      stage: session.stage ?? undefined,
      actor: "system",
      data: {
        pr_url: session.pr_url ?? undefined,
        reason: "gh pr merge --auto queued, waiting for CI",
      },
    });
    return { ok: true, message: "Auto-merge queued -- waiting for CI to pass" };
  },
};

import type { ActionHandler } from "./types.js";
import { mergeWorktreePR } from "../worktree/index.js";

/**
 * `auto_merge` -- queue the session's PR for merge via `gh pr merge --auto`.
 * After queueing, transition the session to `waiting`; `pr-merge-poller`
 * watches GitHub and advances once CI passes and the PR is merged.
 */
export const autoMergeAction: ActionHandler = {
  name: "auto_merge",
  async execute(app, session, action, _opts) {
    const sessionId = session.id;
    // Precondition: a PR must exist for this session before we can merge.
    // Without this gate, a flow whose `create_pr` step failed (or produced
    // no URL) silently advances to `merge` and bombs out deep inside the
    // GitHub client with "Session has no PR URL". Fail fast here so the
    // operator sees the real cause -- no PR to merge -- at the right stage.
    // See #475.
    if (!session.pr_url) {
      return {
        ok: false,
        message: "auto_merge: session has no PR URL -- create_pr did not produce one",
      };
    }
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
        ...session.config,
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

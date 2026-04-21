import type { ActionHandler } from "./types.js";
import { finishWorktree } from "../workspace-service.js";

/**
 * `merge_pr` (alias: `merge`) -- force-merge the session's worktree PR. Differs
 * from `auto_merge` in that this is synchronous: CI is not awaited.
 */
export const mergePrAction: ActionHandler = {
  name: "merge_pr",
  aliases: ["merge"],
  async execute(app, session, action) {
    const result = await finishWorktree(app, session.id, { force: true });
    if (result.ok) {
      await app.events.log(session.id, "action_executed", {
        stage: session.stage ?? undefined,
        actor: "system",
        data: { action },
      });
    }
    return result;
  },
};

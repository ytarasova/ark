import { promisify } from "util";
import { execFile } from "child_process";

import type { ActionHandler } from "./types.js";
import { createWorktreePR } from "../worktree/index.js";
import { logInfo } from "../../observability/structured-log.js";

const execFileAsync = promisify(execFile);

/**
 * `create_pr` action: if the session already tracks a PR (either `pr_url` set,
 * or `gh pr view <branch>` returns one), record that and skip. Otherwise push
 * the worktree branch and call `gh pr create`.
 */
export const createPrAction: ActionHandler = {
  name: "create_pr",
  // opts (incl. idempotencyKey) is handled by the executeAction wrapper in
  // `actions/index.ts`; the handler only receives it for signature parity.
  async execute(app, session, action, _opts) {
    const sessionId = session.id;

    // Skip if we already know about a PR
    if (session.pr_url) {
      await app.events.log(sessionId, "action_executed", {
        stage: session.stage ?? undefined,
        actor: "system",
        data: { action, pr_url: session.pr_url, skipped: "pr_already_exists" },
      });
      return { ok: true, message: `Action '${action}' executed (PR already exists)` };
    }

    // Check if a PR exists on the branch (agent may have created one without reporting pr_url)
    if (session.branch && session.workdir) {
      try {
        const { stdout: prUrl } = await execFileAsync(
          "gh",
          ["pr", "view", session.branch, "--json", "url", "-q", ".url"],
          { cwd: session.workdir, encoding: "utf-8", timeout: 10_000 },
        );
        if (prUrl?.trim()) {
          const url = prUrl.trim();
          await app.sessions.update(sessionId, { pr_url: url });
          await app.events.log(sessionId, "action_executed", {
            stage: session.stage ?? undefined,
            actor: "system",
            data: { action, pr_url: url, skipped: "pr_found_on_branch" },
          });
          return { ok: true, message: `Action '${action}' executed (PR found on branch)` };
        }
      } catch {
        logInfo("session", "no PR exists for this branch -- proceed to create");
      }
    }

    const result = await createWorktreePR(app, sessionId, { title: session.summary ?? undefined });
    if (result.ok) {
      await app.events.log(sessionId, "action_executed", {
        stage: session.stage ?? undefined,
        actor: "system",
        data: { action, pr_url: result.pr_url },
      });
      return { ok: true, message: `Action '${action}' executed` };
    }
    return result;
  },
};

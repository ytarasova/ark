import type { Router } from "../router.js";
import * as core from "../../core/index.js";

export function registerHistoryHandlers(router: Router): void {
  router.handle("history/list", async (p) => {
    const items = core.listClaudeSessions({ limit: (p.limit as number) ?? 100 });
    return { items };
  });

  router.handle("history/import", async (p) => {
    const session = core.startSession({
      summary: (p.name as string) ?? "import",
      repo: (p.repo as string) ?? ".",
      flow: "bare",
      claude_session_id: p.claudeSessionId as string,
    });
    return { session };
  });

  router.handle("history/refresh", async () => {
    await core.refreshClaudeSessionsCache();
    const items = core.listClaudeSessions();
    return { ok: true, count: items.length };
  });
}

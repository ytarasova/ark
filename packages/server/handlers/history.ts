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

  router.handle("history/refresh", async (p) => {
    const count = await core.refreshClaudeSessionsCache({
      onProgress: (p as any).onProgress ?? (() => {}),
    });
    const items = core.listClaudeSessions();
    return { ok: true, count: items.length, sessionCount: count };
  });

  router.handle("history/index", async () => {
    const count = await core.indexTranscripts({ onProgress: () => {} });
    return { ok: true, count };
  });

  router.handle("history/rebuild-fts", async () => {
    const { getDb } = await import("../../core/store.js");
    const db = getDb();
    db.exec("DELETE FROM claude_sessions_cache");
    db.exec("DELETE FROM transcript_index");
    const sessionCount = await core.refreshClaudeSessionsCache({});
    const indexCount = await core.indexTranscripts({});
    const items = core.listClaudeSessions();
    return { ok: true, sessionCount, indexCount, items };
  });

  router.handle("history/refresh-and-index", async () => {
    const sessionCount = await core.refreshClaudeSessionsCache({});
    const indexCount = await core.indexTranscripts({});
    const items = core.listClaudeSessions();
    return { ok: true, sessionCount, indexCount, items };
  });

  router.handle("history/index-stats", async () => {
    const stats = core.getIndexStats();
    return { stats };
  });

  router.handle("history/search", async (p) => {
    const query = p.query as string;
    const limit = (p.limit as number) ?? 20;
    const dbResults = core.searchSessions(query, { limit });
    const txResults = core.searchTranscripts(query, { limit });
    return { results: [...dbResults, ...txResults] };
  });
}

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import * as core from "../../core/index.js";
import type {
  HistoryListParams,
  HistoryImportParams,
  HistorySearchParams,
} from "../../types/index.js";

export function registerHistoryHandlers(router: Router, app: AppContext): void {
  router.handle("history/list", async (p) => {
    const { limit } = extract<HistoryListParams>(p, []);
    const items = core.listClaudeSessions({ limit: limit ?? 100 });
    return { items };
  });

  router.handle("history/import", async (p) => {
    const { claudeSessionId, name, repo } = extract<HistoryImportParams>(p, []);
    const session = core.startSession(core.getApp(), {
      summary: name ?? "import",
      repo: repo ?? ".",
      flow: "bare",
    });
    if (claudeSessionId) {
      core.getApp().sessions.update(session.id, { claude_session_id: claudeSessionId });
    }
    return { session };
  });

  router.handle("history/refresh", async (p) => {
    const count = await core.refreshClaudeSessionsCache({
      onProgress: () => {},
    });
    const items = core.listClaudeSessions();
    return { ok: true, count: items.length, sessionCount: count };
  });

  router.handle("history/index", async () => {
    const count = await core.indexTranscripts({ onProgress: () => {} });
    return { ok: true, count };
  });

  router.handle("history/rebuild-fts", async () => {
    const { getApp } = await import("../../core/app.js");
    const db = getApp().db;
    db.run("DELETE FROM claude_sessions_cache");
    db.run("DELETE FROM transcript_index");
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
    const { query, limit } = extract<HistorySearchParams>(p, ["query"]);
    const dbResults = core.searchSessions(query, { limit: limit ?? 20 });
    const txResults = core.searchTranscripts(query, { limit: limit ?? 20 });
    return { results: [...dbResults, ...txResults] };
  });
}

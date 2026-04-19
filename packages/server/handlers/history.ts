import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import * as core from "../../core/index.js";
import { startSession } from "../../core/services/session-orchestration.js";
import type { HistoryListParams, HistoryImportParams, HistorySearchParams } from "../../types/index.js";

/** True when Ark is running in hosted/multi-tenant mode. */
function isHostedMode(app: AppContext): boolean {
  return typeof app.config.databaseUrl === "string" && app.config.databaseUrl.length > 0;
}

export function registerHistoryHandlers(router: Router, app: AppContext): void {
  router.handle("history/list", async (p) => {
    const { limit } = extract<HistoryListParams>(p, []);
    const items = core.listClaudeSessions(app, { limit: limit ?? 100 });
    return { items };
  });

  router.handle("history/import", async (p) => {
    const { claudeSessionId, name, repo } = extract<HistoryImportParams>(p, []);
    const session = startSession(app, {
      summary: name ?? "import",
      repo: repo ?? ".",
      flow: "bare",
    });
    if (claudeSessionId) {
      app.sessions.update(session.id, { claude_session_id: claudeSessionId });
    }
    return { session };
  });

  router.handle("history/refresh", async (_p) => {
    const count = await core.refreshClaudeSessionsCache(app, {
      onProgress: () => {},
    });
    const items = core.listClaudeSessions(app);
    return { ok: true, count: items.length, sessionCount: count };
  });

  router.handle("history/index", async () => {
    const count = await core.indexTranscripts(app, { onProgress: () => {} });
    return { ok: true, count };
  });

  router.handle("history/rebuild-fts", async () => {
    // claude_sessions_cache and transcript_index index the local user's
    // `~/.claude` transcripts and are NOT tenant-scoped (single-user local
    // mode only). In hosted mode there is no per-tenant transcript cache
    // to rebuild and a global DELETE across the shared cache table from
    // an untrusted tenant would be a DoS. Refuse the call instead.
    if (isHostedMode(app)) {
      throw new Error("history/rebuild-fts is disabled in hosted mode");
    }
    const db = app.db;
    db.run("DELETE FROM claude_sessions_cache");
    db.run("DELETE FROM transcript_index");
    const sessionCount = await core.refreshClaudeSessionsCache(app, {});
    const indexCount = await core.indexTranscripts(app, {});
    const items = core.listClaudeSessions(app);
    return { ok: true, sessionCount, indexCount, items };
  });

  router.handle("history/refresh-and-index", async () => {
    const sessionCount = await core.refreshClaudeSessionsCache(app, {});
    const indexCount = await core.indexTranscripts(app, {});
    const items = core.listClaudeSessions(app);
    return { ok: true, sessionCount, indexCount, items };
  });

  router.handle("history/index-stats", async () => {
    const stats = core.getIndexStats(app);
    return { stats };
  });

  router.handle("history/search", async (p) => {
    const { query, limit } = extract<HistorySearchParams>(p, ["query"]);
    const dbResults = core.searchSessions(app, query, { limit: limit ?? 20 });
    const txResults = core.searchTranscripts(app, query, { limit: limit ?? 20 });
    return { results: [...dbResults, ...txResults] };
  });
}

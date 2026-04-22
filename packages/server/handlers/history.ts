/**
 * Shared history handlers (local + hosted).
 *
 * `history/rebuild-fts` is local-only (it wipes the shared
 * `claude_sessions_cache` + `transcript_index` tables) and lives in
 * `history-local.ts`, registered conditionally in `register.ts`.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import * as core from "../../core/index.js";
import { startSession } from "../../core/services/session-lifecycle.js";
import type { HistoryListParams, HistoryImportParams, HistorySearchParams } from "../../types/index.js";

export function registerHistoryHandlers(router: Router, app: AppContext): void {
  router.handle("history/list", async (p) => {
    const { limit } = extract<HistoryListParams>(p, []);
    const items = core.listClaudeSessions(app, { limit: limit ?? 100 });
    return { items };
  });

  router.handle("history/import", async (p) => {
    const { claudeSessionId, name, repo } = extract<HistoryImportParams>(p, []);
    const session = await startSession(app, {
      summary: name ?? "import",
      repo: repo ?? ".",
      flow: "bare",
    });
    if (claudeSessionId) {
      await app.sessions.update(session.id, { claude_session_id: claudeSessionId });
    }
    return { session };
  });

  router.handle("history/refresh", async (_p) => {
    const count = await core.refreshClaudeSessionsCache(app, {
      onProgress: () => {},
    });
    const items = await core.listClaudeSessions(app);
    return { ok: true, count: items.length, sessionCount: count };
  });

  router.handle("history/index", async () => {
    const count = await core.indexTranscripts(app, { onProgress: () => {} });
    return { ok: true, count };
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
    const dbResults = await core.searchSessions(app, query, { limit: limit ?? 20 });
    const txResults = await core.searchTranscripts(app, query, { limit: limit ?? 20 });
    return { results: [...dbResults, ...txResults] };
  });
}

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
import { resolveTenantApp } from "./scope-helpers.js";
import type { HistoryListParams, HistoryImportParams, HistorySearchParams } from "../../types/index.js";

export function registerHistoryHandlers(router: Router, app: AppContext): void {
  router.handle("history/list", async (p, _notify, ctx) => {
    const { limit } = extract<HistoryListParams>(p, []);
    const scoped = resolveTenantApp(app, ctx);
    const items = core.listClaudeSessions(scoped, { limit: limit ?? 100 });
    return { items };
  });

  router.handle("history/import", async (p, _notify, ctx) => {
    const { claudeSessionId, name, repo } = extract<HistoryImportParams>(p, []);
    const scoped = resolveTenantApp(app, ctx);
    const session = await scoped.sessionLifecycle.start(
      {
        summary: name ?? "import",
        repo: repo ?? ".",
        flow: "bare",
      },
      { onCreated: (id) => scoped.sessionService.emitSessionCreated(id) },
    );
    if (claudeSessionId) {
      await scoped.sessions.update(session.id, { claude_session_id: claudeSessionId });
    }
    return { session };
  });

  router.handle("history/refresh", async (_p, _notify, ctx) => {
    const scoped = resolveTenantApp(app, ctx);
    const count = await core.refreshClaudeSessionsCache(scoped, {
      onProgress: () => {},
    });
    const items = await core.listClaudeSessions(scoped);
    return { ok: true, count: items.length, sessionCount: count };
  });

  router.handle("history/index", async (_p, _notify, ctx) => {
    const scoped = resolveTenantApp(app, ctx);
    const count = await core.indexTranscripts(scoped, { onProgress: () => {} });
    return { ok: true, count };
  });

  router.handle("history/refresh-and-index", async (_p, _notify, ctx) => {
    const scoped = resolveTenantApp(app, ctx);
    const sessionCount = await core.refreshClaudeSessionsCache(scoped, {});
    const indexCount = await core.indexTranscripts(scoped, {});
    const items = core.listClaudeSessions(scoped);
    return { ok: true, sessionCount, indexCount, items };
  });

  router.handle("history/index-stats", async (_p, _notify, ctx) => {
    const scoped = resolveTenantApp(app, ctx);
    const stats = core.getIndexStats(scoped);
    return { stats };
  });

  router.handle("history/search", async (p, _notify, ctx) => {
    const { query, limit } = extract<HistorySearchParams>(p, ["query"]);
    const scoped = resolveTenantApp(app, ctx);
    const dbResults = await core.searchSessions(scoped, query, { limit: limit ?? 20 });
    const txResults = await core.searchTranscripts(scoped, query, { limit: limit ?? 20 });
    return { results: [...dbResults, ...txResults] };
  });
}

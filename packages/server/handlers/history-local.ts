/**
 * Local-mode-only history handlers.
 *
 * `history/rebuild-fts` wipes `claude_sessions_cache` + `transcript_index`
 * tables, which are NOT tenant-scoped (single-user local mode only). Registered
 * conditionally when `app.mode.ftsRebuildCapability` is non-null.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";

export function registerHistoryLocalHandlers(router: Router, app: AppContext): void {
  const fts = app.mode.ftsRebuildCapability;
  if (!fts) {
    throw new Error("ftsRebuildCapability is required to register local-only history handlers");
  }

  router.handle("history/rebuild-fts", async () => {
    const result = await fts.rebuild();
    return { ok: true, ...result };
  });
}

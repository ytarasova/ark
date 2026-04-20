/**
 * Local-mode-only knowledge handlers.
 *
 * These RPCs read/write arbitrary server-side directories (source trees,
 * markdown dumps) and are therefore unsafe in hosted multi-tenant mode where
 * there is no per-tenant filesystem view. Registered via
 * `registerLocalOnlyHandlers` only when `app.mode.knowledgeCapability` is
 * non-null. Handler bodies never inspect a mode flag.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";

export function registerKnowledgeLocalHandlers(router: Router, app: AppContext): void {
  const kg = app.mode.knowledgeCapability;
  if (!kg) {
    throw new Error("knowledgeCapability is required to register local-only knowledge handlers");
  }

  router.handle("knowledge/index", async (p) => {
    const { repo } = extract<{ repo?: string }>(p, []);
    const repoPath = repo ?? process.cwd();
    try {
      const result = await kg.index(repoPath);
      return { ok: true, ...result };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  });

  router.handle("knowledge/export", async (p) => {
    const { dir } = extract<{ dir?: string }>(p, []);
    const result = await kg.export(dir ?? "./knowledge-export");
    return { ok: true, ...result };
  });

  router.handle("knowledge/import", async (p) => {
    const { dir } = extract<{ dir?: string }>(p, []);
    const result = await kg.import(dir ?? "./knowledge-export");
    return { ok: true, ...result };
  });
}

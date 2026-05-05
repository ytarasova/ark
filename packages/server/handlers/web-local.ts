/**
 * Local-mode-only web handlers.
 *
 * Each of these reads or writes arbitrary server-side directories:
 *   - `repo-map/get` generates a map of an arbitrary source tree.
 *   - `knowledge/ingest` indexes an arbitrary path into the knowledge graph.
 *
 * In hosted multi-tenant mode there is no per-tenant filesystem view, so
 * these handlers aren't registered. The capabilities they depend on
 * (`repoMapCapability`, `knowledgeCapability`) are null in hosted mode, so
 * the mount-guard catches the ambiguity.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";

export function registerWebLocalHandlers(router: Router, app: AppContext): void {
  const repoMap = app.mode.repoMapCapability;
  const kg = app.mode.knowledgeCapability;
  if (!repoMap || !kg) {
    throw new Error("repoMapCapability and knowledgeCapability are required");
  }

  router.handle("repo-map/get", async (p) => {
    const { dir } = extract<{ dir?: string }>(p, []);
    return repoMap.generate(dir ?? ".");
  });

  router.handle("knowledge/ingest", async (p) => {
    const { path: inputPath } = extract<{
      path: string;
      directory?: boolean;
      scope?: string;
      tags?: string[];
      recursive?: boolean;
    }>(p, ["path"]);
    try {
      const result = await kg.index(inputPath);
      return { ok: true, files: (result as any).files, chunks: (result as any).symbols };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  });
}

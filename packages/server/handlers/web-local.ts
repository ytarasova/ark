/**
 * Local-mode-only web handlers.
 *
 * Each of these reads or writes arbitrary server-side directories:
 *   - `mcp/attach-by-dir` / `mcp/detach-by-dir` write `<dir>/.claude.json`.
 *   - `repo-map/get` generates a map of an arbitrary source tree.
 *   - `knowledge/ingest` indexes an arbitrary path into the knowledge graph.
 *
 * In hosted multi-tenant mode there is no per-tenant filesystem view, so these
 * handlers aren't registered -- not because they ask. The capabilities they
 * depend on (`mcpDirCapability`, `repoMapCapability`, `knowledgeCapability`)
 * are null in hosted mode, so the mount-guard catches the ambiguity.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";

export function registerWebLocalHandlers(router: Router, app: AppContext): void {
  const mcpDir = app.mode.mcpDirCapability;
  const repoMap = app.mode.repoMapCapability;
  const kg = app.mode.knowledgeCapability;
  if (!mcpDir || !repoMap || !kg) {
    throw new Error("mcpDirCapability, repoMapCapability, and knowledgeCapability are required");
  }

  router.handle("mcp/attach-by-dir", async (p) => {
    const { dir, name, config } = extract<{ dir: string; name: string; config: Record<string, unknown> }>(p, [
      "dir",
      "name",
      "config",
    ]);
    mcpDir.attach(dir, name, config);
    return { ok: true };
  });

  router.handle("mcp/detach-by-dir", async (p) => {
    const { dir, name } = extract<{ dir: string; name: string }>(p, ["dir", "name"]);
    mcpDir.detach(dir, name);
    return { ok: true };
  });

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

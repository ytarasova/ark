import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import type { NodeType } from "../../core/knowledge/types.js";

export function registerKnowledgeHandlers(router: Router, app: AppContext): void {
  router.handle("knowledge/search", async (p) => {
    const { query, types, limit } = extract<{ query: string; types?: NodeType[]; limit?: number }>(p, ["query"]);
    const results = app.knowledge.search(query, { types, limit });
    return { results };
  });

  router.handle("knowledge/stats", async () => {
    const nodeTypes = ["file", "symbol", "session", "memory", "learning", "skill", "recipe", "agent"] as const;
    const edgeTypes = [
      "depends_on",
      "imports",
      "modified_by",
      "learned_from",
      "relates_to",
      "uses",
      "extracted_from",
      "co_changes",
    ] as const;

    const byNodeType: Record<string, number> = {};
    let totalNodes = 0;
    for (const t of nodeTypes) {
      const c = app.knowledge.nodeCount(t);
      if (c > 0) byNodeType[t] = c;
      totalNodes += c;
    }

    const byEdgeType: Record<string, number> = {};
    let totalEdges = 0;
    for (const r of edgeTypes) {
      const c = app.knowledge.edgeCount(r);
      if (c > 0) byEdgeType[r] = c;
      totalEdges += c;
    }

    return {
      nodes: totalNodes,
      edges: totalEdges,
      by_node_type: byNodeType,
      by_edge_type: byEdgeType,
    };
  });

  router.handle("knowledge/index", async (p) => {
    const { repo } = extract<{ repo?: string }>(p, []);
    const repoPath = repo ?? process.cwd();
    try {
      const { indexCodebase } = await import("../../core/knowledge/indexer.js");
      const result = await indexCodebase(repoPath, app.knowledge, { incremental: true });
      return { ok: true, ...result };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  });

  router.handle("knowledge/export", async (p) => {
    const { dir } = extract<{ dir?: string }>(p, []);
    const { exportToMarkdown } = await import("../../core/knowledge/export.js");
    const result = exportToMarkdown(app.knowledge, dir ?? "./knowledge-export");
    return { ok: true, ...result };
  });

  router.handle("knowledge/import", async (p) => {
    const { dir } = extract<{ dir?: string }>(p, []);
    const { importFromMarkdown } = await import("../../core/knowledge/export.js");
    const result = importFromMarkdown(app.knowledge, dir ?? "./knowledge-export");
    return { ok: true, ...result };
  });
}

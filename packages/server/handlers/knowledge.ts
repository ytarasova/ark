/**
 * Shared knowledge-graph handlers (available in both local + hosted modes).
 *
 * Local-only handlers (index/export/import) live in `knowledge-local.ts` and
 * are registered conditionally in `register.ts`. The split keeps the
 * filesystem-touching code in one place and makes the mode contract explicit:
 * `app.mode.knowledgeCapability` must be non-null to register the local set.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import type { NodeType } from "../../core/knowledge/types.js";
import { logInfo } from "../../core/observability/structured-log.js";

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

  // codebase-memory-mcp introspection: is it vendored, what version, what tools
  router.handle("knowledge/codebase/status", async () => {
    const { findCodebaseMemoryBinary } = await import("../../core/knowledge/codebase-memory-finder.js");
    const { existsSync } = await import("fs");
    const { execFileSync } = await import("child_process");
    const bin = findCodebaseMemoryBinary();
    const available = bin !== "codebase-memory-mcp" && existsSync(bin);
    if (!available) {
      return { available: false, path: null, version: null };
    }
    let version: string | null = null;
    try {
      version = execFileSync(bin, ["--version"], { encoding: "utf-8" }).trim();
    } catch {
      logInfo("web", "binary present but --version failed; still report available");
    }
    return {
      available: true,
      path: bin,
      version,
      tools: [
        "index_repository",
        "index_status",
        "detect_changes",
        "search_graph",
        "query_graph",
        "trace_path",
        "get_code_snippet",
        "get_graph_schema",
        "get_architecture",
        "search_code",
        "list_projects",
        "delete_project",
        "manage_adr",
        "ingest_traces",
      ],
    };
  });
}

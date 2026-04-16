import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import type {
  MemoryListParams,
  MemoryRecallParams,
  MemoryForgetParams,
  MemoryAddParams,
  MemoryClearParams,
  MemoryEntry,
} from "../../types/index.js";
import type { KnowledgeNode } from "../../core/knowledge/types.js";

/** Map a KnowledgeNode to the legacy MemoryEntry shape for RPC backward compat. */
function nodeToMemoryEntry(node: KnowledgeNode): MemoryEntry {
  return {
    id: node.id,
    content: node.content ?? node.label,
    tags: Array.isArray(node.metadata.tags) ? (node.metadata.tags as string[]) : [],
    scope: (node.metadata.scope as string) ?? "global",
    importance: typeof node.metadata.importance === "number" ? node.metadata.importance : 0.5,
    createdAt: node.created_at,
    accessedAt: node.updated_at,
    accessCount: typeof node.metadata.accessCount === "number" ? (node.metadata.accessCount as number) : 0,
  };
}

export function registerMemoryHandlers(router: Router, app: AppContext): void {
  router.handle("memory/list", async (p) => {
    const { scope } = extract<MemoryListParams>(p, []);
    const nodes = app.knowledge.listNodes({ type: "memory" });
    const filtered = scope
      ? nodes.filter((n) => (n.metadata.scope as string) === scope || (n.metadata.scope as string) === "global")
      : nodes;
    return { memories: filtered.map(nodeToMemoryEntry) };
  });

  router.handle("memory/recall", async (p) => {
    const { query, scope: _scope, limit } = extract<MemoryRecallParams>(p, ["query"]);
    const results = app.knowledge.search(query, {
      types: ["memory", "learning"],
      limit: limit ?? 10,
    });
    return {
      results: results.map(nodeToMemoryEntry),
    };
  });

  router.handle("memory/forget", async (p) => {
    const { id } = extract<MemoryForgetParams>(p, ["id"]);
    const existing = app.knowledge.getNode(id);
    if (!existing) return { ok: false };
    app.knowledge.removeNode(id);
    return { ok: true };
  });

  router.handle("memory/add", async (p) => {
    const { content, tags, scope, importance } = extract<MemoryAddParams>(p, ["content"]);
    const id = app.knowledge.addNode({
      type: "memory",
      label: content.slice(0, 100),
      content,
      metadata: {
        tags: tags ?? [],
        scope: scope ?? "global",
        importance: importance ?? 0.5,
        accessCount: 0,
      },
    });
    const node = app.knowledge.getNode(id)!;
    return { memory: nodeToMemoryEntry(node) };
  });

  router.handle("memory/clear", async (p) => {
    const { scope } = extract<MemoryClearParams>(p, []);
    if (scope) {
      // Clear memories matching the scope
      const nodes = app.knowledge.listNodes({ type: "memory" });
      let count = 0;
      for (const n of nodes) {
        if ((n.metadata.scope as string) === scope) {
          app.knowledge.removeNode(n.id);
          count++;
        }
      }
      return { count };
    }
    // Clear all memories
    const beforeCount = app.knowledge.nodeCount("memory");
    app.knowledge.clear({ type: "memory" });
    return { count: beforeCount };
  });
}

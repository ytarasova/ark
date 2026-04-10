import type { KnowledgeStore } from "./store.js";
import type { ContextPackage, KnowledgeNode } from "./types.js";

/**
 * Build a context package for an agent about to work on a task.
 */
export function buildContext(
  store: KnowledgeStore,
  task: string,
  opts?: {
    repo?: string;
    files?: string[];
    sessionId?: string;
    limit?: number;
  },
): ContextPackage {
  const limit = opts?.limit ?? 10;
  const ctx: ContextPackage = { files: [], memories: [], sessions: [], learnings: [], skills: [] };

  // 1. Search by task keywords
  const searchResults = store.search(task, { limit: limit * 3 });

  // 2. If specific files provided, get their neighbors
  const fileNeighbors: KnowledgeNode[] = [];
  for (const f of opts?.files ?? []) {
    const neighbors = store.neighbors(`file:${f}`, { maxDepth: 2 });
    fileNeighbors.push(...neighbors);
  }

  // 3. Combine and deduplicate
  const allNodes = new Map<string, KnowledgeNode>();
  for (const n of [...searchResults, ...fileNeighbors]) {
    if (n.id !== `session:${opts?.sessionId}`) {
      allNodes.set(n.id, n);
    }
  }

  // 4. Categorize into context package
  for (const node of allNodes.values()) {
    switch (node.type) {
      case "file":
        if (ctx.files.length < limit) {
          const sessions = store.getEdges(node.id, { relation: "modified_by", direction: "out" });
          ctx.files.push({
            path: node.label,
            language: (node.metadata.language as string) ?? "",
            dependents: store.getEdges(node.id, { direction: "in" }).length,
            recent_sessions: sessions.slice(0, 3).map(e => ({
              id: e.target_id.replace("session:", ""),
              summary: store.getNode(e.target_id)?.label ?? "",
              date: e.created_at,
            })),
          });
        }
        break;
      case "memory":
        if (ctx.memories.length < limit) {
          ctx.memories.push({
            content: node.content ?? node.label,
            importance: (node.metadata.importance as number) ?? 0.5,
            scope: (node.metadata.scope as string) ?? "global",
          });
        }
        break;
      case "session":
        if (ctx.sessions.length < limit) {
          ctx.sessions.push({
            id: node.id.replace("session:", ""),
            summary: node.label,
            outcome: (node.metadata.outcome as string) ?? "",
            files_changed: (node.metadata.files_changed as string[]) ?? [],
            date: node.created_at,
          });
        }
        break;
      case "learning":
        if (ctx.learnings.length < limit) {
          ctx.learnings.push({ title: node.label, description: node.content ?? "" });
        }
        break;
      case "skill":
        if (ctx.skills.length < limit) {
          ctx.skills.push({ name: node.label, description: node.content ?? "" });
        }
        break;
    }
  }

  // Sort memories by importance, sessions by date
  ctx.memories.sort((a, b) => b.importance - a.importance);
  ctx.sessions.sort((a, b) => b.date.localeCompare(a.date));

  return ctx;
}

/**
 * Format a ContextPackage as markdown for injection into agent prompts.
 */
export function formatContextAsMarkdown(ctx: ContextPackage): string {
  const sections: string[] = [];

  if (ctx.memories.length > 0) {
    sections.push("## Relevant Knowledge\n" +
      ctx.memories.map(m => `- ${m.content}`).join("\n"));
  }

  if (ctx.sessions.length > 0) {
    sections.push("## Related Past Sessions\n" +
      ctx.sessions.map(s =>
        `- **${s.id}**: ${s.summary} (${s.outcome}, changed: ${s.files_changed.join(", ")})`
      ).join("\n"));
  }

  if (ctx.files.length > 0) {
    sections.push("## Key Files\n" +
      ctx.files.map(f =>
        `- \`${f.path}\` (${f.language}, ${f.dependents} dependents)`
      ).join("\n"));
  }

  if (ctx.learnings.length > 0) {
    sections.push("## Learnings\n" +
      ctx.learnings.map(l => `- **${l.title}**: ${l.description}`).join("\n"));
  }

  if (ctx.skills.length > 0) {
    sections.push("## Applicable Skills\n" +
      ctx.skills.map(s => `- **${s.name}**: ${s.description}`).join("\n"));
  }

  if (sections.length === 0) return "";
  return "---\n# Context (auto-generated)\n\n" + sections.join("\n\n") + "\n---\n\n";
}

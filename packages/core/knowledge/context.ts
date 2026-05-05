import type { KnowledgeStore } from "./store.js";
import type { ContextPackage, KnowledgeNode } from "./types.js";

const DEFAULT_MAX_TOKENS = 2000;
const CHARS_PER_TOKEN = 4;

const DEFAULT_LIMITS = {
  files: 5,
  memories: 3,
  sessions: 3,
  learnings: 2,
  skills: 2,
};

const MAX_MEMORY_CONTENT = 200;
const MAX_LEARNING_DESC = 150;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

/**
 * Build a context package for an agent about to work on a task.
 */
export async function buildContext(
  store: KnowledgeStore,
  task: string,
  opts?: {
    repo?: string;
    files?: string[];
    sessionId?: string;
    limit?: number;
    maxTokens?: number;
  },
): Promise<ContextPackage> {
  const maxFiles = Math.min(opts?.limit ?? DEFAULT_LIMITS.files, DEFAULT_LIMITS.files);
  const maxMemories = Math.min(opts?.limit ?? DEFAULT_LIMITS.memories, DEFAULT_LIMITS.memories);
  const maxSessions = Math.min(opts?.limit ?? DEFAULT_LIMITS.sessions, DEFAULT_LIMITS.sessions);
  const maxLearnings = Math.min(opts?.limit ?? DEFAULT_LIMITS.learnings, DEFAULT_LIMITS.learnings);
  const maxSkills = Math.min(opts?.limit ?? DEFAULT_LIMITS.skills, DEFAULT_LIMITS.skills);
  const searchLimit = maxFiles + maxMemories + maxSessions + maxLearnings + maxSkills;

  const ctx: ContextPackage = { files: [], memories: [], sessions: [], learnings: [], skills: [] };

  // 1. Search by task keywords
  const searchResults = await store.search(task, { limit: searchLimit * 2 });

  // 2. If specific files provided, get their neighbors
  const fileNeighbors: KnowledgeNode[] = [];
  for (const f of opts?.files ?? []) {
    const neighbors = await store.neighbors(`file:${f}`, { maxDepth: 2 });
    fileNeighbors.push(...neighbors);
  }

  // 3. Combine and deduplicate
  const allNodes = new Map<string, KnowledgeNode>();
  for (const n of [...searchResults, ...fileNeighbors]) {
    if (n.id !== `session:${opts?.sessionId}`) {
      allNodes.set(n.id, n);
    }
  }

  // 4. Categorize into context package with per-type limits
  for (const node of allNodes.values()) {
    switch (node.type) {
      case "file":
        if (ctx.files.length < maxFiles) {
          const sessions = await store.getEdges(node.id, { relation: "modified_by", direction: "out" });
          const inboundEdges = await store.getEdges(node.id, { direction: "in" });
          const recentSessions = await Promise.all(
            sessions.slice(0, 3).map(async (e) => ({
              id: e.target_id.replace("session:", ""),
              summary: (await store.getNode(e.target_id))?.label ?? "",
              date: e.created_at,
            })),
          );
          ctx.files.push({
            path: node.label,
            language: (node.metadata.language as string) ?? "",
            dependents: inboundEdges.length,
            recent_sessions: recentSessions,
          });
        }
        break;
      case "memory":
        if (ctx.memories.length < maxMemories) {
          const raw = node.content ?? node.label;
          ctx.memories.push({
            content: truncate(raw, MAX_MEMORY_CONTENT),
            importance: (node.metadata.importance as number) ?? 0.5,
            scope: (node.metadata.scope as string) ?? "global",
          });
        }
        break;
      case "session":
        if (ctx.sessions.length < maxSessions) {
          // Eval-flagged session nodes are now filtered at the store
          // layer (search/listNodes default-exclude `metadata.eval ===
          // true`). No output-side filter needed here.
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
        if (ctx.learnings.length < maxLearnings) {
          const raw = node.content ?? "";
          ctx.learnings.push({ title: node.label, description: truncate(raw, MAX_LEARNING_DESC) });
        }
        break;
      case "skill":
        if (ctx.skills.length < maxSkills) {
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
export function formatContextAsMarkdown(ctx: ContextPackage, opts?: { maxChars?: number }): string {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_TOKENS * CHARS_PER_TOKEN;
  const parts: string[] = [];
  let charCount = 0;

  const header = "---\n# Context (auto-generated)\n\n";
  const footer = "\n> Use `knowledge/search` and `knowledge/context` MCP tools for deeper exploration.\n";
  const closing = "\n---\n\n";
  const reservedChars = header.length + footer.length + closing.length;

  function addSection(section: string): boolean {
    if (charCount + section.length + 2 > maxChars - reservedChars) return false;
    parts.push(section);
    charCount += section.length + 2;
    return true;
  }

  if (ctx.memories.length > 0) {
    const s = "## Relevant Knowledge\n" + ctx.memories.map((m) => `- ${m.content}`).join("\n");
    addSection(s);
  }

  if (ctx.sessions.length > 0) {
    // Suppress empty trailing parens. When outcome + files_changed are both
    // empty, the old format produced `(, changed: )`; build the suffix
    // conditionally instead so signal-free rows render cleanly. See #480.
    const lines = ctx.sessions.map((s) => {
      const parts: string[] = [];
      if (s.outcome) parts.push(s.outcome);
      if (s.files_changed.length) parts.push(`changed: ${s.files_changed.join(", ")}`);
      const suffix = parts.length ? ` (${parts.join(", ")})` : "";
      return `- **${s.id}**: ${s.summary}${suffix}`;
    });
    addSection("## Related Past Sessions\n" + lines.join("\n"));
  }

  if (ctx.files.length > 0) {
    const s =
      "## Key Files\n" + ctx.files.map((f) => `- \`${f.path}\` (${f.language}, ${f.dependents} dependents)`).join("\n");
    addSection(s);
  }

  if (ctx.learnings.length > 0) {
    const s = "## Learnings\n" + ctx.learnings.map((l) => `- **${l.title}**: ${l.description}`).join("\n");
    addSection(s);
  }

  if (ctx.skills.length > 0) {
    const s = "## Applicable Skills\n" + ctx.skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
    addSection(s);
  }

  if (parts.length === 0) return "";
  return header + parts.join("\n\n") + footer + closing;
}

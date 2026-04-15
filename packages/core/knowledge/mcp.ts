import type { KnowledgeStore } from "./store.js";
import type { NodeType } from "./types.js";

export interface KnowledgeToolResult {
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Handle knowledge MCP tool calls from agents.
 * These tools let agents query the knowledge graph, remember things,
 * and understand file impact/history during a session.
 */
export function handleKnowledgeTool(
  store: KnowledgeStore,
  toolName: string,
  params: Record<string, unknown>,
): KnowledgeToolResult {
  switch (toolName) {
    case "knowledge/search": {
      const query = params.query as string;
      const types = params.types as NodeType[] | undefined;
      const limit = params.limit as number | undefined;
      const results = store.search(query, { types, limit });
      return {
        content: results
          .map((r) => `[${r.type}] ${r.label}: ${r.content?.slice(0, 200) ?? ""} (score: ${r.score.toFixed(2)})`)
          .join("\n\n"),
        metadata: { count: results.length },
      };
    }

    case "knowledge/context": {
      const filePath = params.file as string;
      const node = store.getNode(`file:${filePath}`);
      if (!node) return { content: `File not found in knowledge graph: ${filePath}` };
      const neighbors = store.neighbors(node.id, { maxDepth: 2 });
      const grouped: Record<string, string[]> = {};
      for (const n of neighbors) {
        (grouped[n.type] ??= []).push(`${n.label}: ${n.content?.slice(0, 150) ?? ""}`);
      }
      let content = `## ${filePath}\n`;
      for (const [type, items] of Object.entries(grouped)) {
        content += `\n### ${type}s\n${items.map((i) => `- ${i}`).join("\n")}`;
      }
      return { content };
    }

    case "knowledge/impact": {
      const filePath = params.file as string;
      const dependents = store.neighbors(`file:${filePath}`, {
        relation: "depends_on",
        direction: "in",
        maxDepth: 3,
        types: ["file"],
      });
      const coChanges = store.neighbors(`file:${filePath}`, {
        relation: "co_changes",
        maxDepth: 1,
        types: ["file"],
      });
      return {
        content: [
          `## Impact analysis: ${filePath}`,
          "",
          `### Dependents (${dependents.length})`,
          dependents.map((d) => `- ${d.label}`).join("\n"),
          "",
          `### Co-changes (${coChanges.length})`,
          coChanges.map((c) => `- ${c.label}`).join("\n"),
        ].join("\n"),
      };
    }

    case "knowledge/history": {
      const filePath = params.file as string;
      const sessions = store.neighbors(`file:${filePath}`, {
        relation: "modified_by",
        direction: "out",
        types: ["session"],
      });
      return {
        content: [
          `## History: ${filePath}`,
          "",
          `${sessions.length} sessions modified this file:`,
          sessions.map((s) => `- ${s.label} (${s.metadata.outcome ?? "unknown"})`).join("\n"),
        ].join("\n"),
      };
    }

    case "knowledge/remember": {
      const content = params.content as string;
      const tags = (params.tags as string[]) ?? [];
      const importance = (params.importance as number) ?? 0.5;
      const id = store.addNode({
        type: "memory",
        label: content.slice(0, 100),
        content,
        metadata: { tags, importance, scope: "global" },
      });
      return { content: `Memory stored: ${id}`, metadata: { id } };
    }

    case "knowledge/recall": {
      const query = params.query as string;
      const results = store.search(query, { types: ["memory", "learning"], limit: 10 });
      return {
        content:
          results.length > 0
            ? results.map((r) => `- [${r.type}] ${r.content ?? r.label}`).join("\n")
            : "No relevant memories found.",
      };
    }

    default:
      return { content: `Unknown knowledge tool: ${toolName}` };
  }
}

/**
 * List of knowledge tools for MCP registration.
 * Each entry describes one tool that agents can invoke.
 */
export const KNOWLEDGE_TOOLS = [
  {
    name: "knowledge/search",
    description: "Search across all knowledge (files, memories, sessions, learnings)",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
        types: {
          type: "array",
          items: { type: "string" },
          description: "Filter by node types (file, symbol, session, memory, learning, skill)",
        },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "knowledge/context",
    description: "Everything known about a file -- dependencies, sessions, memories",
    inputSchema: {
      type: "object" as const,
      properties: {
        file: { type: "string", description: "File path" },
      },
      required: ["file"],
    },
  },
  {
    name: "knowledge/impact",
    description: "What breaks if this file changes -- dependents and co-change patterns",
    inputSchema: {
      type: "object" as const,
      properties: {
        file: { type: "string", description: "File path" },
      },
      required: ["file"],
    },
  },
  {
    name: "knowledge/history",
    description: "Past sessions that modified this file",
    inputSchema: {
      type: "object" as const,
      properties: {
        file: { type: "string", description: "File path" },
      },
      required: ["file"],
    },
  },
  {
    name: "knowledge/remember",
    description: "Store a new memory in the knowledge graph",
    inputSchema: {
      type: "object" as const,
      properties: {
        content: { type: "string", description: "Memory content" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization",
        },
        importance: { type: "number", description: "Importance 0-1 (default 0.5)" },
      },
      required: ["content"],
    },
  },
  {
    name: "knowledge/recall",
    description: "Search memories and learnings",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
];

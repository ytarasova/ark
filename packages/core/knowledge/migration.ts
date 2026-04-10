import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { KnowledgeStore } from "./store.js";

/**
 * Migrate memories.json into knowledge table.
 */
export function migrateMemories(store: KnowledgeStore, arkDir: string): { migrated: number } {
  const path = join(arkDir, "memories.json");
  if (!existsSync(path)) return { migrated: 0 };

  // Check if already migrated
  if (store.nodeCount("memory") > 0) return { migrated: 0 };

  let memories: any[];
  try {
    memories = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { migrated: 0 };
  }

  if (!Array.isArray(memories)) return { migrated: 0 };

  let migrated = 0;

  for (const m of memories) {
    store.addNode({
      id: m.id ?? `memory:${Date.now()}-${migrated}`,
      type: "memory",
      label: (m.content ?? "").slice(0, 100),
      content: m.content,
      metadata: {
        tags: m.tags ?? [],
        scope: m.scope ?? "global",
        importance: m.importance ?? 0.5,
        accessCount: m.accessCount ?? 0,
      },
    });
    migrated++;
  }

  return { migrated };
}

/**
 * Migrate LEARNINGS.md + POLICY.md into knowledge table.
 */
export function migrateLearnings(store: KnowledgeStore, arkDir: string): { migrated: number } {
  const conductorDir = join(arkDir, "conductor");
  let migrated = 0;

  for (const filename of ["LEARNINGS.md", "POLICY.md"]) {
    const path = join(conductorDir, filename);
    if (!existsSync(path)) continue;

    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch {
      continue;
    }

    const sections = content.split(/^## /m).slice(1); // skip header

    for (const section of sections) {
      const lines = section.trim().split("\n");
      const title = lines[0]?.trim() ?? "Untitled";
      const body = lines.slice(1).join("\n").trim();

      // Parse recurrence from body
      const recurrenceMatch = body.match(/\*\*Recurrence:\*\*\s*(\d+)/);
      const recurrence = recurrenceMatch ? parseInt(recurrenceMatch[1]) : 1;

      const nodeId = `learning:${title.toLowerCase().replace(/\s+/g, "-").slice(0, 50)}`;

      // Skip if node already exists (idempotent)
      if (store.getNode(nodeId)) continue;

      store.addNode({
        id: nodeId,
        type: "learning",
        label: title,
        content: body,
        metadata: {
          recurrence,
          source: filename === "POLICY.md" ? "policy" : "learning",
        },
      });
      migrated++;
    }
  }

  return { migrated };
}

/**
 * Run all migrations. Called on boot. Idempotent.
 */
export function runKnowledgeMigrations(store: KnowledgeStore, arkDir: string): void {
  migrateMemories(store, arkDir);
  migrateLearnings(store, arkDir);
}

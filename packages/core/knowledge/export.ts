/**
 * Export/import knowledge nodes as markdown files.
 * Memories, learnings, and skills can be stored as .md files for
 * version control, sharing, and manual editing.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { join, basename } from "path";
import type { KnowledgeStore } from "./store.js";
import type { KnowledgeNode, NodeType } from "./types.js";

/**
 * Export knowledge nodes as individual markdown files.
 * Each node becomes one .md file with YAML frontmatter.
 *
 * Example output:
 * ```markdown
 * ---
 * id: memory:abc123
 * type: memory
 * importance: 0.9
 * scope: global
 * tags: [auth, security]
 * ---
 *
 * Never modify auth middleware without updating the session validator.
 * The two are tightly coupled since the JWT refactor in session s-abc123.
 * ```
 */
export async function exportToMarkdown(
  store: KnowledgeStore,
  outputDir: string,
  opts?: { types?: NodeType[] },
): Promise<{ exported: number }> {
  mkdirSync(outputDir, { recursive: true });
  const types = opts?.types ?? ["memory", "learning"];
  let exported = 0;

  for (const type of types) {
    const typeDir = join(outputDir, type);
    mkdirSync(typeDir, { recursive: true });

    const nodes = await store.listNodes({ type });
    for (const node of nodes) {
      const filename = sanitizeFilename(node.label) + ".md";
      const frontmatter = buildFrontmatter(node);
      const content = `---\n${frontmatter}---\n\n${node.content ?? ""}\n`;
      writeFileSync(join(typeDir, filename), content, "utf-8");
      exported++;
    }
  }

  return { exported };
}

/**
 * Import markdown files back into the knowledge store.
 * Reads .md files with YAML frontmatter, creates/updates nodes.
 *
 * Directory structure:
 * ```
 * knowledge/
 *   memory/
 *     auth-middleware-rule.md
 *     jwt-token-format.md
 *   learning/
 *     always-run-tests.md
 * ```
 */
export async function importFromMarkdown(store: KnowledgeStore, inputDir: string): Promise<{ imported: number }> {
  if (!existsSync(inputDir)) return { imported: 0 };
  let imported = 0;

  for (const typeDir of readdirSync(inputDir, { withFileTypes: true })) {
    if (!typeDir.isDirectory()) continue;
    const type = typeDir.name as NodeType;
    if (!["memory", "learning", "skill", "recipe", "agent"].includes(type)) continue;

    const dirPath = join(inputDir, type);
    for (const file of readdirSync(dirPath).filter((f) => f.endsWith(".md"))) {
      const raw = readFileSync(join(dirPath, file), "utf-8");
      const { frontmatter, body } = parseFrontmatter(raw);

      const id = frontmatter.id ?? `${type}:${basename(file, ".md")}`;
      const label = frontmatter.label ?? basename(file, ".md").replace(/-/g, " ");
      const metadata: Record<string, unknown> = {};

      // Preserve known metadata fields
      if (frontmatter.importance !== undefined) metadata.importance = Number(frontmatter.importance);
      if (frontmatter.scope) metadata.scope = frontmatter.scope;
      if (frontmatter.tags)
        metadata.tags = Array.isArray(frontmatter.tags)
          ? frontmatter.tags
          : String(frontmatter.tags)
              .split(",")
              .map((t) => t.trim());
      if (frontmatter.recurrence !== undefined) metadata.recurrence = Number(frontmatter.recurrence);
      if (frontmatter.source) metadata.source = frontmatter.source;

      // Upsert: remove old if exists, then add
      const existing = await store.getNode(id);
      if (existing) await store.removeNode(id);

      await store.addNode({ id, type, label, content: body.trim(), metadata });
      imported++;
    }
  }

  return { imported };
}

// --- Helpers ---

function sanitizeFilename(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "untitled"
  );
}

function buildFrontmatter(node: KnowledgeNode): string {
  const lines: string[] = [];
  lines.push(`id: ${node.id}`);
  lines.push(`type: ${node.type}`);
  if (node.metadata.importance !== undefined) lines.push(`importance: ${node.metadata.importance}`);
  if (node.metadata.scope) lines.push(`scope: ${node.metadata.scope}`);
  if (Array.isArray(node.metadata.tags) && node.metadata.tags.length > 0) {
    lines.push(`tags: [${(node.metadata.tags as string[]).join(", ")}]`);
  }
  if (node.metadata.recurrence !== undefined) lines.push(`recurrence: ${node.metadata.recurrence}`);
  if (node.metadata.source) lines.push(`source: ${node.metadata.source}`);
  return lines.join("\n") + "\n";
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, any>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };

  const fm: Record<string, any> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: any = line.slice(colonIdx + 1).trim();

    // Parse arrays: [a, b, c]
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((s: string) => s.trim());
    }
    fm[key] = value;
  }

  return { frontmatter: fm, body: match[2] };
}

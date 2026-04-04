/**
 * Knowledge ingestion — feed project docs into searchable store.
 * Supports text files, markdown, and basic web content.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";
import { remember, recall, type MemoryEntry } from "./memory.js";

/** Ingest a file into the memory system. */
export function ingestFile(filePath: string, opts?: { scope?: string; tags?: string[] }): number {
  if (!existsSync(filePath)) return 0;

  const ext = extname(filePath).toLowerCase();
  const supported = [".md", ".txt", ".rst", ".adoc", ".csv", ".json", ".yaml", ".yml"];
  if (!supported.includes(ext)) return 0;

  const content = readFileSync(filePath, "utf-8");
  const chunks = chunkText(content, 500);  // ~500 word chunks

  for (const chunk of chunks) {
    if (chunk.trim().length < 20) continue;  // skip tiny chunks
    remember(chunk.trim(), {
      scope: opts?.scope ?? "knowledge",
      tags: [...(opts?.tags ?? []), `file:${filePath}`],
      importance: 0.7,
    });
  }

  return chunks.length;
}

/** Ingest all supported files in a directory. */
export function ingestDirectory(dirPath: string, opts?: { scope?: string; tags?: string[]; recursive?: boolean }): { files: number; chunks: number } {
  if (!existsSync(dirPath)) return { files: 0, chunks: 0 };

  let fileCount = 0;
  let chunkCount = 0;

  const entries = readdirSync(dirPath);
  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    const stat = statSync(fullPath);

    if (stat.isFile()) {
      const n = ingestFile(fullPath, opts);
      if (n > 0) { fileCount++; chunkCount += n; }
    } else if (stat.isDirectory() && opts?.recursive !== false) {
      // Skip hidden dirs and common non-content dirs
      if (entry.startsWith(".") || ["node_modules", "dist", "build", "__pycache__"].includes(entry)) continue;
      const sub = ingestDirectory(fullPath, opts);
      fileCount += sub.files;
      chunkCount += sub.chunks;
    }
  }

  return { files: fileCount, chunks: chunkCount };
}

/** Query knowledge base. */
export function queryKnowledge(query: string, opts?: { scope?: string; limit?: number }): MemoryEntry[] {
  return recall(query, { scope: opts?.scope ?? "knowledge", limit: opts?.limit ?? 5 });
}

/** Split text into chunks of approximately N words. */
export function chunkText(text: string, maxWords: number): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const words = para.split(/\s+/).length;
    if (current && current.split(/\s+/).length + words > maxWords) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

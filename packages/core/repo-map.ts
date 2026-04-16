/**
 * Repository map -- compressed codebase structure for agent context.
 * Scans files and extracts function/class/export signatures.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, extname, relative } from "path";

export interface RepoMapEntry {
  path: string;
  type: "file";
  exports: string[];  // function/class/type names
  size: number;       // bytes
}

export interface RepoMap {
  root: string;
  entries: RepoMapEntry[];
  totalFiles: number;
  summary: string;
}

const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", ".git", ".next", ".nuxt",
  "__pycache__", ".venv", "venv", "target", ".ark", ".claude",
  "coverage", ".nyc_output", ".turbo",
]);

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java",
  ".rb", ".php", ".c", ".cpp", ".h", ".hpp", ".cs", ".swift",
  ".kt", ".scala", ".vue", ".svelte",
]);

const EXPORT_PATTERNS: Record<string, RegExp[]> = {
  ".ts": [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+(?:const|let)\s+(\w+)/g,
    /export\s+interface\s+(\w+)/g,
    /export\s+type\s+(\w+)/g,
  ],
  ".tsx": [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
    /export\s+(?:const|let)\s+(\w+)/g,
  ],
  ".js": [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+class\s+(\w+)/g,
  ],
  ".py": [/^def\s+(\w+)/gm, /^class\s+(\w+)/gm],
  ".go": [/^func\s+(\w+)/gm, /^type\s+(\w+)\s+struct/gm],
  ".rs": [/pub\s+fn\s+(\w+)/g, /pub\s+struct\s+(\w+)/g, /pub\s+enum\s+(\w+)/g],
};

// Exported for testing
export { SKIP_DIRS, CODE_EXTENSIONS };

/** Scan a repository and generate a structure map. */
export function generateRepoMap(rootDir: string, opts?: { maxFiles?: number; maxDepth?: number }): RepoMap {
  const maxFiles = opts?.maxFiles ?? 500;
  const maxDepth = opts?.maxDepth ?? 10;
  const entries: RepoMapEntry[] = [];

  function scan(dir: string, depth: number): void {
    if (depth > maxDepth || entries.length >= maxFiles) return;
    if (!existsSync(dir)) return;

    let items: string[];
    try { items = readdirSync(dir); }
    catch { return; }

    for (const item of items) {
      if (entries.length >= maxFiles) break;
      if (item.startsWith(".") && item !== ".env.example") continue;
      if (SKIP_DIRS.has(item)) continue;

      const fullPath = join(dir, item);
      let stat;
      try { stat = statSync(fullPath); }
      catch { continue; }

      if (stat.isDirectory()) {
        scan(fullPath, depth + 1);
      } else if (stat.isFile()) {
        const ext = extname(item).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext)) continue;

        const relPath = relative(rootDir, fullPath);
        const exports = extractExports(fullPath, ext);
        entries.push({ path: relPath, type: "file", exports, size: stat.size });
      }
    }
  }

  scan(rootDir, 0);

  // Sort by path for consistent output
  entries.sort((a, b) => a.path.localeCompare(b.path));

  // Generate summary
  const summary = formatRepoMap(entries);

  return { root: rootDir, entries, totalFiles: entries.length, summary };
}

export function extractExports(filePath: string, ext: string): string[] {
  const patterns = EXPORT_PATTERNS[ext] ?? EXPORT_PATTERNS[".ts"];
  if (!patterns) return [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const exports: string[] = [];

    for (const pattern of patterns) {
      // Reset regex lastIndex for global patterns
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        if (match[1]) exports.push(match[1]);
      }
    }

    return [...new Set(exports)];
  } catch {
    return [];
  }
}

/** Format the repo map as a compact string for agent context injection. */
export function formatRepoMap(entries: RepoMapEntry[], maxTokens?: number): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.exports.length > 0) {
      lines.push(`${entry.path}: ${entry.exports.join(", ")}`);
    } else {
      lines.push(entry.path);
    }
  }

  let result = lines.join("\n");

  // Truncate if over token budget (rough: 4 chars per token)
  const budget = (maxTokens ?? 2000) * 4;
  if (result.length > budget) {
    result = result.slice(0, budget) + "\n... (truncated)";
  }

  return result;
}

/**
 * files-extractor -- walks a repo via `git ls-files`, persists files rows.
 *
 * One row per (path, sha) using `git hash-object` to compute the blob sha.
 * Language is detected from the file extension. mtime + size_bytes come
 * from `fs.stat`. Caller persists rows tagged with the current run.
 */

import { existsSync, statSync } from "fs";
import { extname, join } from "path";
import type { Extractor, ExtractorContext, ExtractorRow } from "../interfaces/extractor.js";
import type { Repo } from "../interfaces/types.js";
import { runGit } from "../util/git.js";

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".c": "c",
  ".h": "c",
  ".hpp": "cpp",
  ".swift": "swift",
  ".scala": "scala",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
  ".toml": "toml",
  ".md": "markdown",
  ".sql": "sql",
};

function detectLanguage(path: string): string | null {
  return LANGUAGE_BY_EXT[extname(path).toLowerCase()] ?? null;
}

export const filesExtractor: Extractor = {
  name: "files",
  produces: ["files"],
  supports(repo: Repo): boolean {
    return !!repo.local_path && existsSync(join(repo.local_path, ".git"));
  },
  async *run(ctx: ExtractorContext): AsyncIterable<ExtractorRow> {
    const repoPath = ctx.repo.local_path!;
    const lsResult = runGit(repoPath, ["ls-files", "--cached", "--others", "--exclude-standard"]);
    if (!lsResult.ok) return;
    const files = lsResult.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const relPath of files) {
      if (ctx.signal?.aborted) return;
      const abs = join(repoPath, relPath);
      let sizeBytes: number | null = null;
      let mtime: string | null = null;
      try {
        const s = statSync(abs);
        sizeBytes = s.size;
        mtime = s.mtime.toISOString();
      } catch {
        // File may have been deleted between ls-files and stat; skip silently.
        continue;
      }
      const hashResult = runGit(repoPath, ["hash-object", "--", relPath]);
      const sha = hashResult.ok ? hashResult.stdout.trim() : "";
      if (!sha) continue;
      yield {
        kind: "files",
        row: {
          tenant_id: ctx.repo.tenant_id,
          repo_id: ctx.repo.id,
          path: relPath,
          sha,
          mtime,
          language: detectLanguage(relPath),
          size_bytes: sizeBytes,
          indexing_run_id: ctx.run.id,
        },
      };
    }
  },
};

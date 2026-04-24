/**
 * Pre-accept the Claude trust dialog for directories / worktrees so an
 * agent launch never stalls on an interactive prompt.
 *
 * Writes to `~/.claude.json` and symlinks the per-project state dir.
 */

import { existsSync, readFileSync, writeFileSync, symlinkSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

/** Pre-accept trust dialog and symlink project settings for a worktree. */
export function trustWorktree(originalRepo: string, worktreeDir: string): void {
  const projectsDir = join(homedir(), ".claude", "projects");
  const encode = (p: string) => resolve(p).replace(/\//g, "-").replace(/\./g, "-");

  const origProject = join(projectsDir, encode(originalRepo));
  const wtProject = join(projectsDir, encode(worktreeDir));

  if (existsSync(origProject) && !existsSync(wtProject)) {
    try {
      symlinkSync(origProject, wtProject);
    } catch (e: any) {
      console.error(`trustWorktree: failed to symlink ${origProject} -> ${wtProject}:`, e?.message ?? e);
    }
  }

  trustDirectory(worktreeDir);
}

/** Pre-accept trust dialog for a local directory. */
export function trustDirectory(dir: string): void {
  const claudeJsonPath = join(homedir(), ".claude.json");
  try {
    const claudeJson = existsSync(claudeJsonPath) ? JSON.parse(readFileSync(claudeJsonPath, "utf-8")) : {};
    if (!claudeJson.projects) claudeJson.projects = {};
    const resolvedPath = resolve(dir);
    if (!claudeJson.projects[resolvedPath]?.hasTrustDialogAccepted) {
      claudeJson.projects[resolvedPath] = {
        ...(claudeJson.projects[resolvedPath] ?? {}),
        hasTrustDialogAccepted: true,
      };
      writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
    }
  } catch (e: any) {
    console.error(`trustDirectory: failed to update ${claudeJsonPath}:`, e?.message ?? e);
  }
}

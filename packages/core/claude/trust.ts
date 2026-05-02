/**
 * Pre-accept the Claude trust dialog for directories / worktrees so an
 * agent launch never stalls on an interactive prompt.
 *
 * Writes to `~/.claude.json` and symlinks the per-project state dir.
 *
 * **Local-mode only.** Both functions mutate the conductor process owner's
 * home directory (`~/.claude.json`, `~/.claude/projects/`). In hosted
 * (control-plane) mode the conductor is multi-tenant and shares a pod with
 * other tenants' dispatches -- mutating the pod's HOME is a cross-tenant
 * corruption vector and (more importantly) irrelevant: agents run on a
 * separate compute target, not the conductor pod, so the conductor's
 * `~/.claude.json` is never read by any agent.
 *
 * Each function checks an `ARK_MODE` env signal that the AppContext sets at
 * boot. The env-var route avoids importing AppContext into a leaf module
 * (these helpers are called from worktree setup which already has the
 * AppContext in hand, but the trust file is also occasionally invoked from
 * places that don't, e.g. the launcher). When the signal is missing we
 * default to local-mode behaviour to preserve the laptop install path.
 */

import { existsSync, readFileSync, writeFileSync, symlinkSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

/**
 * Hosted-mode guard. The conductor stamps `ARK_MODE=hosted` on its own
 * process env at boot (see `app.ts:_initFilesystem`); leaf helpers like this
 * one read the env directly to avoid taking an AppContext dependency.
 *
 * Default is local: missing/unset env preserves the laptop install path.
 */
function isHostedMode(): boolean {
  return process.env.ARK_MODE === "hosted";
}

/** Pre-accept trust dialog and symlink project settings for a worktree. */
export function trustWorktree(originalRepo: string, worktreeDir: string): void {
  // Hosted mode: the conductor pod's HOME is shared and trust state lives on
  // the agent's compute target, not here. No-op so we don't corrupt the pod.
  if (isHostedMode()) return;

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
  // See trustWorktree: hosted mode never mutates the conductor pod's HOME.
  if (isHostedMode()) return;

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

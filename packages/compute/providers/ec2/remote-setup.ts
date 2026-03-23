/**
 * Remote setup helpers for EC2 dispatch.
 *
 * Resolves git repos, clones them on the remote host, pre-trusts directories
 * in Claude's config, and handles the development-channels acceptance prompt.
 */

import { sshExecAsync } from "./ssh.js";

/**
 * Extract git remote URL from a local repo path.
 */
export function getGitRemoteUrl(localPath: string): string | null {
  // Use execFileSync since this runs locally, not on remote
  const { execFileSync } = require("child_process");
  try {
    return execFileSync("git", ["-C", localPath, "remote", "get-url", "origin"], {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim() || null;
  } catch { return null; }
}

/**
 * Resolve a repo reference to a git clone URL.
 * Handles: "org/repo", "https://github.com/...", "/local/path", "git@github.com:..."
 */
export function resolveRepoUrl(repo: string): string | null {
  if (repo.startsWith("git@") || repo.startsWith("https://")) return repo;
  if (repo.includes("/") && !repo.startsWith("/")) return `git@github.com:${repo}.git`;
  // Local path - extract remote
  return getGitRemoteUrl(repo);
}

/**
 * Get short repo name from URL or path.
 */
export function getRepoName(repoUrlOrPath: string): string {
  const base = repoUrlOrPath.split("/").pop() ?? "repo";
  return base.replace(/\.git$/, "");
}

/**
 * Clone repo on remote host into a timestamped directory.
 * Returns the remote working directory path.
 */
export async function cloneRepoOnRemote(
  key: string, ip: string,
  repoUrl: string, repoName: string,
  opts?: { branch?: string; sessionId?: string; onLog?: (msg: string) => void },
): Promise<string> {
  const log = opts?.onLog ?? (() => {});
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(4, 12); // MMDD-HHMM (e.g. 03221430)
  const branchSuffix = opts?.branch ? `-${opts.branch.split("/").pop()}` : "";
  const dirName = `${repoName}${branchSuffix}-${ts}`;
  const remotePath = `/home/ubuntu/Projects/${dirName}`;

  // Ensure Projects directory exists
  await sshExecAsync(key, ip, "mkdir -p ~/Projects", { timeout: 5000 });

  // Clone
  const branchFlag = opts?.branch ? `-b ${opts.branch}` : "";
  log(`Cloning ${repoUrl} into ${dirName}...`);
  const { exitCode, stderr } = await sshExecAsync(key, ip,
    `cd ~/Projects && git clone ${branchFlag} ${repoUrl} ${dirName}`,
    { timeout: 120_000 });

  if (exitCode !== 0) {
    throw new Error(`Git clone failed: ${stderr.slice(0, 200)}`);
  }

  log(`Cloned to ${remotePath}`);
  return remotePath;
}

/**
 * Pre-trust a directory in Claude's config on the remote host.
 */
export async function trustRemoteDirectory(
  key: string, ip: string, remotePath: string,
): Promise<void> {
  // Use python3 since it's always available on Ubuntu
  const script = `python3 -c "
import json, os
f = os.path.expanduser('~/.claude.json')
j = json.load(open(f)) if os.path.exists(f) else {}
j.setdefault('projects', {})
j['projects']['${remotePath}'] = {'hasTrustDialogAccepted': True}
json.dump(j, open(f, 'w'), indent=2)
" 2>/dev/null || echo '{"projects":{"${remotePath}":{"hasTrustDialogAccepted":true}}}' > ~/.claude.json`;
  await sshExecAsync(key, ip, script, { timeout: 10_000 });
}

/**
 * Auto-accept the development channels prompt on remote tmux.
 */
export async function autoAcceptChannelPrompt(
  key: string, ip: string, tmuxName: string,
): Promise<void> {
  const { poll } = await import("../../util.js");
  await poll(
    async () => {
      const { stdout } = await sshExecAsync(key, ip,
        `tmux capture-pane -t ${tmuxName} -p 2>/dev/null | tail -20`,
        { timeout: 10_000 });
      if (stdout.includes("I am using this for local")) {
        await sshExecAsync(key, ip, `tmux send-keys -t ${tmuxName} Enter`);
        return true;
      }
      return stdout.includes("Welcome") || stdout.includes("Claude Code v");
    },
    { maxAttempts: 15, delayMs: 1000 },
  );
}

/**
 * Environment sync for EC2 hosts.
 * Syncs credentials and project files between local machine and remote EC2 host.
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { homedir, tmpdir, userInfo } from "os";
import { join } from "path";

import { rsyncPush, rsyncPull, sshExec } from "./ssh.js";

// ---------------------------------------------------------------------------
// Path rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite absolute home-directory paths when moving content between
 * the local Mac and the remote Ubuntu EC2 host.
 *
 * - push: /Users/{currentUser} -> /home/ubuntu
 * - pull: /home/ubuntu -> /Users/{currentUser}
 */
export function rewritePaths(content: string, direction: "push" | "pull"): string {
  const localHome = `/Users/${userInfo().username}`;
  const remoteHome = "/home/ubuntu";

  if (direction === "push") {
    return content.replaceAll(localHome, remoteHome);
  }
  return content.replaceAll(remoteHome, localHome);
}

// ---------------------------------------------------------------------------
// Sync steps
// ---------------------------------------------------------------------------

export interface SyncStep {
  name: string;
  push: (key: string, ip: string) => void;
  pull: (key: string, ip: string) => void;
}

function syncSshPush(key: string, ip: string): void {
  const sshDir = join(homedir(), ".ssh");
  if (!existsSync(sshDir)) return;

  sshExec(key, ip, "mkdir -p ~/.ssh && chmod 700 ~/.ssh");

  // rsync the whole directory, excluding ark-* keys to avoid recursive key problem
  rsyncPush(key, ip, sshDir + "/", "~/.ssh/");

  // Remove any ark-* keys that may have slipped through (belt and suspenders)
  sshExec(key, ip, "rm -f ~/.ssh/ark-* 2>/dev/null");

  // Fix permissions and populate known_hosts for github.com
  sshExec(key, ip,
    "chmod 600 ~/.ssh/id_* 2>/dev/null; " +
    "ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null",
  );
}

function syncSshPull(_key: string, _ip: string): void {
  // SSH keys are push-only — we never pull remote keys to local
}

function syncAwsPush(key: string, ip: string): void {
  const awsDir = join(homedir(), ".aws");
  sshExec(key, ip, "mkdir -p ~/.aws");
  if (existsSync(join(awsDir, "config"))) {
    rsyncPush(key, ip, join(awsDir, "config"), "~/.aws/");
  }
  if (existsSync(join(awsDir, "credentials"))) {
    rsyncPush(key, ip, join(awsDir, "credentials"), "~/.aws/");
  }
}

function syncAwsPull(_key: string, _ip: string): void {
  // AWS credentials are push-only
}

function syncGitPush(key: string, ip: string): void {
  const gitconfig = join(homedir(), ".gitconfig");
  if (existsSync(gitconfig)) {
    rsyncPush(key, ip, gitconfig, "~/");
  }
}

function syncGitPull(_key: string, _ip: string): void {
  // Git config is push-only
}

function syncGhPush(key: string, ip: string): void {
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (token) {
      sshExec(key, ip, `echo '${token}' | gh auth login --with-token 2>/dev/null`);
    }
  } catch {
    // gh CLI not installed or not authenticated — skip
  }
}

function syncGhPull(_key: string, _ip: string): void {
  // GH token is push-only
}

function syncClaudePush(key: string, ip: string): void {
  const claudeDir = join(homedir(), ".claude");
  if (!existsSync(claudeDir)) return;

  sshExec(key, ip, "mkdir -p ~/.claude");

  // Copy to a temp dir so we can rewrite paths without modifying local files
  const tmp = mkdtempSync(join(tmpdir(), "ark-claude-push-"));
  try {
    // rsync local .claude/ into temp
    execFileSync("rsync", ["-a", claudeDir + "/", tmp + "/"], {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Rewrite paths in all JSON files within temp
    rewriteJsonFiles(tmp, "push");

    // Push rewritten temp dir to remote
    rsyncPush(key, ip, tmp + "/", "~/.claude/");
  } finally {
    execFileSync("rm", ["-rf", tmp]);
  }
}

function syncClaudePull(key: string, ip: string): void {
  const claudeDir = join(homedir(), ".claude");
  mkdirSync(claudeDir, { recursive: true });

  // Pull into a temp dir first so we can rewrite paths
  const tmp = mkdtempSync(join(tmpdir(), "ark-claude-pull-"));
  try {
    rsyncPull(key, ip, "~/.claude/", tmp + "/");

    // Rewrite paths in all JSON files within temp (reverse direction)
    rewriteJsonFiles(tmp, "pull");

    // Copy rewritten files to local .claude/
    execFileSync("rsync", ["-a", tmp + "/", claudeDir + "/"], {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } finally {
    execFileSync("rm", ["-rf", tmp]);
  }
}

/** Recursively find and rewrite JSON files in a directory. */
function rewriteJsonFiles(dir: string, direction: "push" | "pull"): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteJsonFiles(full, direction);
    } else if (entry.name.endsWith(".json")) {
      try {
        const content = readFileSync(full, "utf-8");
        const rewritten = rewritePaths(content, direction);
        if (rewritten !== content) {
          writeFileSync(full, rewritten);
        }
      } catch {
        // Skip files that can't be read/written
      }
    }
  }
}

export const SYNC_STEPS: SyncStep[] = [
  { name: "ssh",    push: syncSshPush,    pull: syncSshPull },
  { name: "aws",    push: syncAwsPush,    pull: syncAwsPull },
  { name: "git",    push: syncGitPush,    pull: syncGitPull },
  { name: "gh",     push: syncGhPush,     pull: syncGhPull },
  { name: "claude", push: syncClaudePush, pull: syncClaudePull },
];

// ---------------------------------------------------------------------------
// High-level sync
// ---------------------------------------------------------------------------

/**
 * Execute sync steps by category. Returns which succeeded and which failed.
 */
export function syncToHost(
  key: string,
  ip: string,
  opts: { direction: "push" | "pull"; categories?: string[] },
): { synced: string[]; failed: string[] } {
  const synced: string[] = [];
  const failed: string[] = [];

  const steps = opts.categories
    ? SYNC_STEPS.filter((s) => opts.categories!.includes(s.name))
    : SYNC_STEPS;

  for (const step of steps) {
    try {
      if (opts.direction === "push") {
        step.push(key, ip);
      } else {
        step.pull(key, ip);
      }
      synced.push(step.name);
    } catch {
      failed.push(step.name);
    }
  }

  return { synced, failed };
}

/**
 * Push specific project files from a local directory to a remote working directory.
 * These are typically the arc.json "sync" files (.env, terraform.tfvars, etc.)
 */
export function syncProjectFiles(
  key: string,
  ip: string,
  files: string[],
  localDir: string,
  remoteDir: string,
): void {
  sshExec(key, ip, `mkdir -p ${remoteDir}`);
  for (const file of files) {
    const localPath = join(localDir, file);
    if (existsSync(localPath)) {
      // Ensure remote subdirectories exist for nested paths
      const parts = file.split("/");
      if (parts.length > 1) {
        const subdir = parts.slice(0, -1).join("/");
        sshExec(key, ip, `mkdir -p ${remoteDir}/${subdir}`);
      }
      rsyncPush(key, ip, localPath, `${remoteDir}/${file}`);
    }
  }
}

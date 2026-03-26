/**
 * Environment sync for EC2 hosts.
 * Syncs credentials and project files between local machine and remote EC2 host.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { homedir, tmpdir, userInfo } from "os";
import { join } from "path";

import { rsyncPush, rsyncPull, sshExec } from "./ssh.js";

const execFileAsync = promisify(execFile);

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
  push: (key: string, ip: string) => Promise<void>;
  pull: (key: string, ip: string) => Promise<void>;
}

async function syncSshPush(key: string, ip: string): Promise<void> {
  const sshDir = join(homedir(), ".ssh");
  if (!existsSync(sshDir)) return;

  await sshExec(key, ip, "mkdir -p ~/.ssh && chmod 700 ~/.ssh");

  // rsync the whole directory, excluding ark-* keys to avoid recursive key problem
  await rsyncPush(key, ip, sshDir + "/", "~/.ssh/");

  // Remove any ark-* keys that may have slipped through (belt and suspenders)
  await sshExec(key, ip, "rm -f ~/.ssh/ark-* 2>/dev/null");

  // Fix permissions and populate known_hosts for github.com
  await sshExec(key, ip,
    "chmod 600 ~/.ssh/id_* 2>/dev/null; " +
    "ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null",
  );
}

async function syncSshPull(_key: string, _ip: string): Promise<void> {
  // SSH keys are push-only - we never pull remote keys to local
}

async function syncAwsPush(key: string, ip: string): Promise<void> {
  const awsDir = join(homedir(), ".aws");
  await sshExec(key, ip, "mkdir -p ~/.aws");
  if (existsSync(join(awsDir, "config"))) {
    await rsyncPush(key, ip, join(awsDir, "config"), "~/.aws/");
  }
  if (existsSync(join(awsDir, "credentials"))) {
    await rsyncPush(key, ip, join(awsDir, "credentials"), "~/.aws/");
  }
}

async function syncAwsPull(_key: string, _ip: string): Promise<void> {
  // AWS credentials are push-only
}

async function syncGitPush(key: string, ip: string): Promise<void> {
  const gitconfig = join(homedir(), ".gitconfig");
  if (existsSync(gitconfig)) {
    await rsyncPush(key, ip, gitconfig, "~/");
  }
}

async function syncGitPull(_key: string, _ip: string): Promise<void> {
  // Git config is push-only
}

async function syncGhPush(key: string, ip: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    const token = stdout.trim();
    if (token) {
      await sshExec(key, ip, `echo '${token}' | gh auth login --with-token 2>/dev/null`);
    }
  } catch {
    // gh CLI not installed or not authenticated - skip
  }
}

async function syncGhPull(_key: string, _ip: string): Promise<void> {
  // GH token is push-only
}

async function syncClaudePush(key: string, ip: string): Promise<void> {
  const claudeDir = join(homedir(), ".claude");
  if (!existsSync(claudeDir)) return;

  await sshExec(key, ip, "mkdir -p ~/.claude");

  // Copy to a temp dir so we can rewrite paths without modifying local files
  const tmp = mkdtempSync(join(tmpdir(), "ark-claude-push-"));
  try {
    // rsync local .claude/ into temp
    await execFileAsync("rsync", ["-a", claudeDir + "/", tmp + "/"], {
      encoding: "utf-8",
      timeout: 30_000,
    });

    // Rewrite paths in all JSON files within temp
    rewriteJsonFiles(tmp, "push");

    // Push rewritten temp dir to remote
    await rsyncPush(key, ip, tmp + "/", "~/.claude/");
  } finally {
    await execFileAsync("rm", ["-rf", tmp]);
  }

  // Sync auth + onboarding from ~/.claude.json so Claude skips first-run setup
  const claudeJsonPath = join(homedir(), ".claude.json");
  if (existsSync(claudeJsonPath)) {
    try {
      const local = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
      const remote: Record<string, unknown> = {};
      if (local.oauthAccount) remote.oauthAccount = local.oauthAccount;
      if (local.hasCompletedOnboarding) remote.hasCompletedOnboarding = true;
      remote.numStartups = 1;
      remote.autoUpdates = false;

      if (remote.oauthAccount) {
        const encoded = Buffer.from(JSON.stringify(remote)).toString("base64");
        await sshExec(key, ip,
          `echo '${encoded}' | base64 -d > /tmp/ark-claude-auth.json && python3 -c "import json; e=json.load(open('/home/ubuntu/.claude.json')) if __import__('os').path.exists('/home/ubuntu/.claude.json') else {}; e.update(json.load(open('/tmp/ark-claude-auth.json'))); json.dump(e, open('/home/ubuntu/.claude.json','w'), indent=2); print('ok')"`,
          { timeout: 15_000 },
        );
      }
    } catch { /* auth sync is best-effort */ }
  }
}

async function syncClaudePull(key: string, ip: string): Promise<void> {
  const claudeDir = join(homedir(), ".claude");
  mkdirSync(claudeDir, { recursive: true });

  // Pull into a temp dir first so we can rewrite paths
  const tmp = mkdtempSync(join(tmpdir(), "ark-claude-pull-"));
  try {
    await rsyncPull(key, ip, "~/.claude/", tmp + "/");

    // Rewrite paths in all JSON files within temp (reverse direction)
    rewriteJsonFiles(tmp, "pull");

    // Copy rewritten files to local .claude/
    await execFileAsync("rsync", ["-a", tmp + "/", claudeDir + "/"], {
      encoding: "utf-8",
      timeout: 30_000,
    });
  } finally {
    await execFileAsync("rm", ["-rf", tmp]);
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
export async function syncToHost(
  key: string,
  ip: string,
  opts: { direction: "push" | "pull"; categories?: string[] },
): Promise<{ synced: string[]; failed: string[] }> {
  const synced: string[] = [];
  const failed: string[] = [];

  const steps = opts.categories
    ? SYNC_STEPS.filter((s) => opts.categories!.includes(s.name))
    : SYNC_STEPS;

  for (const step of steps) {
    try {
      if (opts.direction === "push") {
        await step.push(key, ip);
      } else {
        await step.pull(key, ip);
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
export async function syncProjectFiles(
  key: string,
  ip: string,
  files: string[],
  localDir: string,
  remoteDir: string,
): Promise<void> {
  await sshExec(key, ip, `mkdir -p ${remoteDir}`);
  for (const file of files) {
    const localPath = join(localDir, file);
    if (existsSync(localPath)) {
      // Ensure remote subdirectories exist for nested paths
      const parts = file.split("/");
      if (parts.length > 1) {
        const subdir = parts.slice(0, -1).join("/");
        await sshExec(key, ip, `mkdir -p ${remoteDir}/${subdir}`);
      }
      await rsyncPush(key, ip, localPath, `${remoteDir}/${file}`);
    }
  }
}

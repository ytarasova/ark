/**
 * Environment sync for EC2 hosts.
 *
 * Syncs AWS config, gitconfig, gh auth token, and the Claude CLI cache
 * (~/.claude + ~/.claude.json) between the local machine and the remote
 * EC2 host. Also pushes per-project sync files (e.g. arc.json "sync"
 * entries like .env, terraform.tfvars).
 *
 * SSH credentials are NOT synced here. They flow via typed-secret
 * placement (see packages/core/secrets/placers/ssh-private-key.ts and
 * the EC2 placement context in packages/compute/providers/ec2/placement-ctx.ts).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { homedir, tmpdir, userInfo } from "os";
import { join } from "path";

import { rsyncPush, rsyncPull, sshExec, sshExecArgs } from "./ssh.js";
import { shellEscape } from "./shell-escape.js";
import { REMOTE_USER, REMOTE_HOME } from "./constants.js";
import { safeAsync } from "../../../core/safe.js";

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
  const remoteHome = REMOTE_HOME;

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
  await safeAsync("[ec2] syncGhPush: gh auth token", async () => {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    const token = stdout.trim();
    if (!token) return;
    const encoded = Buffer.from(token).toString("base64");
    await sshExec(key, ip, `echo ${encoded} | base64 -d | gh auth login --with-token 2>/dev/null`, { timeout: 15_000 });
  });
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
    const local = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    if (local.oauthAccount) {
      const remote: Record<string, unknown> = {
        oauthAccount: local.oauthAccount,
        hasCompletedOnboarding: true,
        numStartups: 1,
        autoUpdates: false,
      };
      const tmp = mkdtempSync(join(tmpdir(), "ark-claudejson-"));
      try {
        const tmpFile = join(tmp, ".claude.json");
        writeFileSync(tmpFile, JSON.stringify(remote, null, 2));
        // scp directly -- rsync has edge cases with dotfiles and --update
        await execFileAsync(
          "scp",
          [
            "-i",
            key,
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "ConnectTimeout=10",
            tmpFile,
            `${REMOTE_USER}@${ip}:${REMOTE_HOME}/.claude.json`,
          ],
          { encoding: "utf-8", timeout: 30_000 },
        );
      } finally {
        await execFileAsync("rm", ["-rf", tmp]);
      }
    }
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

/** Rewrite paths in a single JSON file, logging errors without throwing. */
function rewriteSingleJsonFile(path: string, direction: "push" | "pull"): void {
  try {
    const content = readFileSync(path, "utf-8");
    const rewritten = rewritePaths(content, direction);
    if (rewritten !== content) writeFileSync(path, rewritten);
  } catch (e: any) {
    console.error(`[ec2] rewriteJsonFiles: failed to process ${path}:`, e?.message ?? e);
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
      rewriteSingleJsonFile(full, direction);
    }
  }
}

/**
 * Refresh the Claude session access token on a remote host.
 * Called periodically to keep the remote agent authenticated.
 */
export async function refreshRemoteToken(key: string, ip: string): Promise<void> {
  const token = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN;
  if (!token) return;
  // Write token to the remote's environment for running tmux sessions
  // The token is picked up by Claude when it refreshes its auth.
  //
  // The token is env-supplied and therefore not directly attacker-controlled,
  // but a single-quote in the value (or future leakage from less-trusted
  // sources) breaks out of the old `'${token}'` interpolation and runs on
  // the remote shell. Shell-escape defensively so this is safe by
  // construction regardless of the token's contents.
  const escapedToken = shellEscape(token);
  await sshExec(
    key,
    ip,
    `for sess in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^ark-'); do tmux set-environment -t "$sess" CLAUDE_CODE_SESSION_ACCESS_TOKEN ${escapedToken} 2>/dev/null; done`,
    { timeout: 10_000 },
  );
}

export const SYNC_STEPS: SyncStep[] = [
  { name: "aws", push: syncAwsPush, pull: syncAwsPull },
  { name: "git", push: syncGitPush, pull: syncGitPull },
  { name: "gh", push: syncGhPush, pull: syncGhPull },
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
  opts: { direction: "push" | "pull"; categories?: string[]; onLog?: (msg: string) => void },
): Promise<{ synced: string[]; failed: string[] }> {
  const log = opts.onLog ?? (() => {});
  const synced: string[] = [];
  const failed: string[] = [];

  const steps = opts.categories ? SYNC_STEPS.filter((s) => opts.categories!.includes(s.name)) : SYNC_STEPS;

  const total = steps.length;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    log(`Syncing ${step.name} (${i + 1}/${total})...`);
    try {
      if (opts.direction === "push") {
        await step.push(key, ip);
      } else {
        await step.pull(key, ip);
      }
      synced.push(step.name);
      log(`${step.name} ✓ (${i + 1}/${total})`);
    } catch (e: any) {
      failed.push(step.name);
      console.error(`[ec2] syncToHost: step '${step.name}' ${opts.direction} failed:`, e?.message ?? e);
      log(`${step.name} failed (${i + 1}/${total})`);
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
  // `remoteDir` is derived from session.workdir / arc.json. Both can be
  // attacker-controlled in hosted mode -- use argv-based exec so shell
  // metacharacters are quoted rather than interpreted.
  await sshExecArgs(key, ip, ["mkdir", "-p", remoteDir]);
  for (const file of files) {
    const localPath = join(localDir, file);
    if (!existsSync(localPath)) continue;

    const parts = file.split("/");
    if (parts.length > 1) {
      const subdir = parts.slice(0, -1).join("/");
      await sshExecArgs(key, ip, ["mkdir", "-p", `${remoteDir}/${subdir}`]);
    }
    await rsyncPush(key, ip, localPath, `${remoteDir}/${file}`);
  }
}

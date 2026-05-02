/**
 * Environment sync for EC2 hosts.
 *
 * Syncs AWS config, gitconfig, gh auth token, and the Claude CLI cache
 * (~/.claude + ~/.claude.json) between the local machine and the remote
 * EC2 host. Also pushes per-project sync files (e.g. arc.json "sync"
 * entries like .env, terraform.tfvars).
 *
 * Transport: pure AWS SSM. Files travel as base64-encoded blobs inside an
 * `AWS-RunShellScript` SendCommand. Pull (host -> local) is implemented by
 * `cat <file> | base64` on the remote and decoding the captured stdout.
 *
 * SSH credentials are NOT synced here. They flow via typed-secret
 * placement (see packages/core/secrets/placers/ssh-private-key.ts and
 * the EC2 placement context in packages/compute/providers/ec2/placement-ctx.ts).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { homedir, userInfo } from "os";
import { join, relative } from "path";

import { ssmExec, ssmExecArgs, type SsmConnectOpts } from "./ssm.js";
import { shellEscape } from "./shell-escape.js";
import { REMOTE_HOME } from "./constants.js";
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
// Generic push/pull helpers (base64 over SSM SendCommand)
// ---------------------------------------------------------------------------

/** Push a single local file to a remote absolute path via SSM. */
async function pushFile(instanceId: string, localPath: string, remotePath: string, ssm: SsmConnectOpts): Promise<void> {
  if (!existsSync(localPath)) return;
  const bytes = readFileSync(localPath);
  const encoded = bytes.toString("base64");
  const dirIdx = remotePath.lastIndexOf("/");
  const dir = dirIdx >= 0 ? remotePath.slice(0, dirIdx) || "/" : ".";
  const cmd = [
    `mkdir -p ${shellEscape(dir)}`,
    `printf %s ${shellEscape(encoded)} | base64 -d > ${shellEscape(remotePath)}`,
  ].join(" && ");
  await ssmExec({ instanceId, region: ssm.region, awsProfile: ssm.awsProfile, command: cmd, timeoutMs: 120_000 });
}

/** Push a local directory tree (files only) to a remote directory via SSM. */
async function pushDir(instanceId: string, localDir: string, remoteDir: string, ssm: SsmConnectOpts): Promise<void> {
  if (!existsSync(localDir)) return;
  const queue: string[] = [localDir];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(localDir, full);
      const dest = `${remoteDir.replace(/\/$/, "")}/${rel}`;
      await pushFile(instanceId, full, dest, ssm);
    }
  }
}

/** Pull a single remote file to a local path via SSM (cat | base64). */
async function pullFile(instanceId: string, remotePath: string, localPath: string, ssm: SsmConnectOpts): Promise<void> {
  const cmd = `if [ -f ${shellEscape(remotePath)} ]; then base64 ${shellEscape(remotePath)}; fi`;
  const { stdout } = await ssmExec({
    instanceId,
    region: ssm.region,
    awsProfile: ssm.awsProfile,
    command: cmd,
    timeoutMs: 120_000,
  });
  if (!stdout.trim()) return;
  const dirIdx = localPath.lastIndexOf("/");
  if (dirIdx >= 0) mkdirSync(localPath.slice(0, dirIdx), { recursive: true });
  writeFileSync(localPath, Buffer.from(stdout.trim(), "base64"));
}

// ---------------------------------------------------------------------------
// Sync steps
// ---------------------------------------------------------------------------

export interface SyncStep {
  name: string;
  push: (instanceId: string, ssm: SsmConnectOpts) => Promise<void>;
  pull: (instanceId: string, ssm: SsmConnectOpts) => Promise<void>;
}

async function syncAwsPush(instanceId: string, ssm: SsmConnectOpts): Promise<void> {
  const awsDir = join(homedir(), ".aws");
  await ssmExec({ instanceId, region: ssm.region, awsProfile: ssm.awsProfile, command: "mkdir -p ~/.aws" });
  if (existsSync(join(awsDir, "config"))) {
    await pushFile(instanceId, join(awsDir, "config"), `${REMOTE_HOME}/.aws/config`, ssm);
  }
  if (existsSync(join(awsDir, "credentials"))) {
    await pushFile(instanceId, join(awsDir, "credentials"), `${REMOTE_HOME}/.aws/credentials`, ssm);
  }
}

async function syncAwsPull(_instanceId: string, _ssm: SsmConnectOpts): Promise<void> {
  // AWS credentials are push-only
}

async function syncGitPush(instanceId: string, ssm: SsmConnectOpts): Promise<void> {
  const gitconfig = join(homedir(), ".gitconfig");
  if (existsSync(gitconfig)) {
    await pushFile(instanceId, gitconfig, `${REMOTE_HOME}/.gitconfig`, ssm);
  }
}

async function syncGitPull(_instanceId: string, _ssm: SsmConnectOpts): Promise<void> {
  // Git config is push-only
}

async function syncGhPush(instanceId: string, ssm: SsmConnectOpts): Promise<void> {
  await safeAsync("[ec2] syncGhPush: gh auth token", async () => {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    const token = stdout.trim();
    if (!token) return;
    const encoded = Buffer.from(token).toString("base64");
    await ssmExec({
      instanceId,
      region: ssm.region,
      awsProfile: ssm.awsProfile,
      command: `echo ${shellEscape(encoded)} | base64 -d | gh auth login --with-token 2>/dev/null`,
      timeoutMs: 15_000,
    });
  });
}

async function syncGhPull(_instanceId: string, _ssm: SsmConnectOpts): Promise<void> {
  // GH token is push-only
}

async function syncClaudePush(instanceId: string, ssm: SsmConnectOpts): Promise<void> {
  const claudeDir = join(homedir(), ".claude");
  if (!existsSync(claudeDir)) return;

  await ssmExec({ instanceId, region: ssm.region, awsProfile: ssm.awsProfile, command: "mkdir -p ~/.claude" });

  // Walk the local .claude tree, rewriting paths in JSON files inline before push.
  // Avoids the legacy rsync+temp-dir dance by encoding each file separately.
  const queue: string[] = [claudeDir];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(claudeDir, full);
      const dest = `${REMOTE_HOME}/.claude/${rel}`;
      let bytes: Buffer = readFileSync(full);
      if (entry.name.endsWith(".json")) {
        try {
          const rewritten = rewritePaths(bytes.toString("utf-8"), "push");
          bytes = Buffer.from(rewritten);
        } catch {
          // best-effort -- leave bytes as-is on parse/decode failure
        }
      }
      const encoded = bytes.toString("base64");
      const dirIdx = dest.lastIndexOf("/");
      const dir = dirIdx >= 0 ? dest.slice(0, dirIdx) : ".";
      const cmd = [
        `mkdir -p ${shellEscape(dir)}`,
        `printf %s ${shellEscape(encoded)} | base64 -d > ${shellEscape(dest)}`,
      ].join(" && ");
      await ssmExec({
        instanceId,
        region: ssm.region,
        awsProfile: ssm.awsProfile,
        command: cmd,
        timeoutMs: 120_000,
      });
    }
  }

  // Sync auth + onboarding from ~/.claude.json so Claude skips first-run setup
  const claudeJsonPath = join(homedir(), ".claude.json");
  if (existsSync(claudeJsonPath)) {
    try {
      const local = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
      if (local.oauthAccount) {
        const remote: Record<string, unknown> = {
          oauthAccount: local.oauthAccount,
          hasCompletedOnboarding: true,
          numStartups: 1,
          autoUpdates: false,
        };
        const encoded = Buffer.from(JSON.stringify(remote, null, 2)).toString("base64");
        const dest = `${REMOTE_HOME}/.claude.json`;
        const cmd = `printf %s ${shellEscape(encoded)} | base64 -d > ${shellEscape(dest)}`;
        await ssmExec({
          instanceId,
          region: ssm.region,
          awsProfile: ssm.awsProfile,
          command: cmd,
          timeoutMs: 30_000,
        });
      }
    } catch (e: any) {
      console.error(`[ec2] syncClaudePush: failed to push .claude.json:`, e?.message ?? e);
    }
  }
}

async function syncClaudePull(instanceId: string, ssm: SsmConnectOpts): Promise<void> {
  const claudeDir = join(homedir(), ".claude");
  mkdirSync(claudeDir, { recursive: true });

  // List remote files first; we use `find` to enumerate then pull each one.
  const { stdout } = await ssmExec({
    instanceId,
    region: ssm.region,
    awsProfile: ssm.awsProfile,
    command: `find ${REMOTE_HOME}/.claude -type f -print 2>/dev/null || true`,
    timeoutMs: 15_000,
  });
  const files = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const remoteRoot = `${REMOTE_HOME}/.claude/`;
  for (const remote of files) {
    if (!remote.startsWith(remoteRoot)) continue;
    const rel = remote.slice(remoteRoot.length);
    const local = join(claudeDir, rel);
    await pullFile(instanceId, remote, local, ssm);
    // Reverse path-rewrite for JSON files we just pulled.
    if (local.endsWith(".json") && existsSync(local)) {
      try {
        const content = readFileSync(local, "utf-8");
        const rewritten = rewritePaths(content, "pull");
        if (rewritten !== content) writeFileSync(local, rewritten);
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Refresh the Claude session access token on a remote host.
 * Called periodically to keep the remote agent authenticated.
 */
export async function refreshRemoteToken(instanceId: string, ssm: SsmConnectOpts): Promise<void> {
  const token = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN;
  if (!token) return;
  const escapedToken = shellEscape(token);
  await ssmExec({
    instanceId,
    region: ssm.region,
    awsProfile: ssm.awsProfile,
    command: `for sess in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^ark-'); do tmux set-environment -t "$sess" CLAUDE_CODE_SESSION_ACCESS_TOKEN ${escapedToken} 2>/dev/null; done`,
    timeoutMs: 10_000,
  });
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
  instanceId: string,
  opts: {
    direction: "push" | "pull";
    region: string;
    awsProfile?: string;
    categories?: string[];
    onLog?: (msg: string) => void;
  },
): Promise<{ synced: string[]; failed: string[] }> {
  const log = opts.onLog ?? (() => {});
  const ssm: SsmConnectOpts = { region: opts.region, awsProfile: opts.awsProfile };
  const synced: string[] = [];
  const failed: string[] = [];

  const steps = opts.categories ? SYNC_STEPS.filter((s) => opts.categories!.includes(s.name)) : SYNC_STEPS;

  const total = steps.length;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    log(`Syncing ${step.name} (${i + 1}/${total})...`);
    try {
      if (opts.direction === "push") {
        await step.push(instanceId, ssm);
      } else {
        await step.pull(instanceId, ssm);
      }
      synced.push(step.name);
      log(`${step.name} done (${i + 1}/${total})`);
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
  instanceId: string,
  files: string[],
  localDir: string,
  remoteDir: string,
  ssm: SsmConnectOpts,
): Promise<void> {
  // `remoteDir` is derived from session.workdir / arc.json. Both can be
  // attacker-controlled in hosted mode -- use argv-based exec so shell
  // metacharacters are quoted rather than interpreted.
  await ssmExecArgs({ instanceId, region: ssm.region, awsProfile: ssm.awsProfile, argv: ["mkdir", "-p", remoteDir] });
  for (const file of files) {
    const localPath = join(localDir, file);
    if (!existsSync(localPath)) continue;
    const stat = statSync(localPath);
    const remoteDest = `${remoteDir.replace(/\/$/, "")}/${file}`;
    if (stat.isDirectory()) {
      await pushDir(instanceId, localPath, remoteDest, ssm);
    } else {
      await pushFile(instanceId, localPath, remoteDest, ssm);
    }
  }
}

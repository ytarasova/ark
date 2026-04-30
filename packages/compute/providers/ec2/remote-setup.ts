/**
 * Remote setup helpers for EC2 dispatch.
 *
 * Resolves git repos, clones them on the remote host, pre-trusts directories
 * in Claude's config, and handles the development-channels acceptance prompt.
 *
 * SSH transport is via SSM Session Manager; the host arg is an instance_id.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { sshExecAsync, type SsmConnectOpts } from "./ssh.js";
import { REMOTE_HOME } from "./constants.js";

const execFileAsync = promisify(execFile);

/**
 * Extract git remote URL from a local repo path.
 */
export async function getGitRemoteUrl(localPath: string): Promise<string | null> {
  try {
    // stdio "pipe" so git's stderr doesn't leak to our process stderr for soft failures
    const { stdout } = await execFileAsync("git", ["-C", localPath, "remote", "get-url", "origin"], {
      encoding: "utf-8",
    });
    return stdout.trim() || null;
  } catch {
    // Expected for non-git dirs, missing origin, etc. -- caller handles null
    return null;
  }
}

/**
 * Resolve a repo reference to a git clone URL.
 * Handles: "org/repo", "https://github.com/...", "/local/path", "git@github.com:..."
 */
export async function resolveRepoUrl(repo: string): Promise<string | null> {
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
  key: string,
  instanceId: string,
  ssm: SsmConnectOpts,
  repoUrl: string,
  repoName: string,
  opts?: { branch?: string; sessionId?: string; onLog?: (msg: string) => void },
): Promise<string> {
  const log = opts?.onLog ?? (() => {});
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(4, 12); // MMDD-HHMM (e.g. 03221430)
  const branchSuffix = opts?.branch ? `-${opts.branch.split("/").pop()}` : "";
  const dirName = `${repoName}${branchSuffix}-${ts}`;
  const remotePath = `${REMOTE_HOME}/Projects/${dirName}`;

  // Ensure Projects directory exists
  await sshExecAsync(key, instanceId, "mkdir -p ~/Projects", { ...ssm, timeout: 5000 });

  // Clone
  const branchFlag = opts?.branch ? `-b ${opts.branch}` : "";
  log(`Cloning ${repoUrl} into ${dirName}...`);
  const { exitCode, stderr } = await sshExecAsync(
    key,
    instanceId,
    `cd ~/Projects && git clone ${branchFlag} ${repoUrl} ${dirName}`,
    { ...ssm, timeout: 120_000 },
  );

  if (exitCode !== 0) {
    throw new Error(`Git clone failed: ${stderr.slice(0, 200)}${stderr.length > 200 ? "..." : ""}`);
  }

  log(`Cloned to ${remotePath}`);
  return remotePath;
}

/**
 * Pre-trust a directory in Claude's config on the remote host.
 */
export async function trustRemoteDirectory(
  key: string,
  instanceId: string,
  ssm: SsmConnectOpts,
  remotePath: string,
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
  await sshExecAsync(key, instanceId, script, { ...ssm, timeout: 10_000 });
}

/** Markers that indicate the channel development prompt is visible. */
const CHANNEL_PROMPT_MARKERS = ["I am using this for local", "local channel development"];

/** Markers that indicate Claude is past all prompts and actively working. */
const CLAUDE_WORKING_MARKERS = ["ctrl+o to expand", "esc to interrupt"];

/** Single iteration of the channel prompt poll loop. */
async function pollChannelPrompt(
  key: string,
  instanceId: string,
  ssm: SsmConnectOpts,
  tmuxName: string,
  attempt: number,
  max: number,
): Promise<"done" | "retry"> {
  try {
    const { stdout } = await sshExecAsync(
      key,
      instanceId,
      `tmux capture-pane -t '${tmuxName}' -p 2>/dev/null | tail -30`,
      { ...ssm, timeout: 10_000 },
    );

    if (CHANNEL_PROMPT_MARKERS.some((m) => stdout.includes(m))) {
      await sshExecAsync(key, instanceId, `tmux send-keys -t '${tmuxName}' 1`, { ...ssm, timeout: 5_000 });
      const { sleep } = await import("../../util.js");
      await sleep(300);
      await sshExecAsync(key, instanceId, `tmux send-keys -t '${tmuxName}' Enter`, { ...ssm, timeout: 5_000 });
      return "retry";
    }

    if (CLAUDE_WORKING_MARKERS.some((m) => stdout.includes(m))) return "done";
    return "retry";
  } catch (e: any) {
    console.error(
      `[ec2] autoAcceptChannelPrompt: ssh to ${tmuxName} failed (attempt ${attempt + 1}/${max}):`,
      e?.message ?? e,
    );
    return "retry";
  }
}

/**
 * Auto-accept the development channels prompt on remote tmux.
 *
 * The launcher may use `--resume <id> || --session-id <id>`, which causes
 * TWO Claude startups (and two channel prompts) when resume fails.
 * We keep polling after acceptance until Claude is actually working.
 */
export async function autoAcceptChannelPrompt(
  key: string,
  instanceId: string,
  ssm: SsmConnectOpts,
  tmuxName: string,
  opts?: { maxAttempts?: number; delayMs?: number },
): Promise<void> {
  const max = opts?.maxAttempts ?? 60;
  const delay = opts?.delayMs ?? 2000;
  const { sleep } = await import("../../util.js");

  for (let i = 0; i < max; i++) {
    await sleep(delay);
    const result = await pollChannelPrompt(key, instanceId, ssm, tmuxName, i, max);
    if (result === "done") return;
  }
}

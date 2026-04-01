/**
 * EC2 compute provider - implements ComputeProvider for AWS EC2 instances.
 *
 * Ties together all EC2 modules: SSH, cloud-init, sync, metrics, ports.
 * Provision/destroy via Pulumi with cloud-init. Full lifecycle: provision, start, stop, reboot, destroy.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { promisify } from "util";
import {
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  RebootInstancesCommand,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";
import { fromIni } from "@aws-sdk/credential-providers";
import type {
  ComputeProvider,
  ProvisionOpts,
  LaunchOpts,
  SyncOpts,
  ComputeSnapshot,
  PortDecl,
  PortStatus,
} from "../../types.js";
import type { Compute, Session } from "../../../core/store.js";
import { updateCompute, mergeComputeConfig, sessionChannelPort } from "../../../core/store.js";
import { sshKeyPath, sshExec, sshExecAsync, waitForSsh, waitForSshAsync, generateSshKey, rsyncPush } from "./ssh.js";
import { buildUserData } from "./cloud-init.js";
import { provisionStack, destroyStack, resolveInstanceType, ensurePulumi } from "./provision.js";
import { syncToHost, syncProjectFiles, refreshRemoteToken } from "./sync.js";
import { SSH_FAST_CMD, parseSnapshot } from "./metrics.js";
import { setupTunnels, setupReverseTunnel, probeRemotePorts } from "./ports.js";
import { hourlyRate } from "./cost.js";
import { sleep, poll } from "../../util.js";
import { resolveRepoUrl, getRepoName, cloneRepoOnRemote, trustRemoteDirectory, autoAcceptChannelPrompt } from "./remote-setup.js";
import { getOrCreatePool, destroyPool, destroyAllPools, type SSHPool } from "./pool.js";
import { SSHQueue } from "./queue.js";
import { REMOTE_USER, REMOTE_HOME } from "./constants.js";

/** Max time to wait for SSH to come back after a reboot */
const REBOOT_TIMEOUT_MS = 180_000;

interface SessionConfig {
  remoteWorkdir?: string;
  ports?: Array<{ port: number; source: string }>;
  worktree?: boolean;
  github_url?: string;
  [key: string]: unknown;
}

interface EC2HostConfig {
  size?: string;
  arch?: string;
  region?: string;
  aws_profile?: string;
  subnet_id?: string;
  sg_id?: string;
  instance_id?: string;
  ip?: string;
  stack_name?: string;
  key_name?: string;
  hourlyRate?: number;
  cloud_init_done?: boolean;
  last_error?: string;
  idle_minutes?: number;
  ingress_cidrs?: string[];
  tags?: Record<string, string>;
}

function createEc2Client(cfg: EC2HostConfig): EC2Client {
  return new EC2Client({
    region: cfg.region ?? "us-east-1",
    ...(cfg.aws_profile ? { credentials: fromIni({ profile: cfg.aws_profile }) } : {}),
  });
}

// ── Extracted helpers for provision() ─────────────────────────────────────────

interface ToolCheck {
  name: string;
  test: string;
  fix: string;
}

const REQUIRED_TOOLS: ToolCheck[] = [
  { name: "claude", test: "test -f ~/.local/bin/claude", fix: "curl -fsSL https://claude.ai/install.sh | bash" },
  { name: "ark", test: "test -f ~/.ark/bin/ark", fix: "curl -fsSL https://ytarasova.github.io/ark/install.sh | bash -s -- --latest" },
  { name: "bun", test: "test -f ~/.bun/bin/bun", fix: "curl -fsSL https://bun.sh/install | bash" },
  { name: "tmux", test: "which tmux", fix: "sudo apt-get install -y tmux" },
  { name: "git", test: "which git", fix: "sudo apt-get install -y git" },
];

/** Poll cloud-init until .ark-ready sentinel appears. */
async function waitForCloudInit(
  key: string, ip: string, computeName: string, onLog: (msg: string) => void,
): Promise<void> {
  onLog("Waiting for cloud-init to complete...");
  await poll(
    async () => {
      const { stdout } = await sshExecAsync(key, ip, `cat ${REMOTE_HOME}/.ark-ready 2>/dev/null || echo 'not ready'`, { timeout: 15_000 });
      if (stdout.trim().includes("provisioning complete")) {
        onLog("Cloud-init complete");
        mergeComputeConfig(computeName, { cloud_init_done: true });
        return true;
      }
      const { stdout: progress } = await sshExecAsync(key, ip,
        "tail -1 /var/log/cloud-init-output.log 2>/dev/null || echo 'waiting...'", { timeout: 15_000 });
      const line = progress.trim()
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")  // strip ANSI
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")  // strip control chars
        .slice(0, 100);
      if (line && line !== "waiting...") onLog(`cloud-init: ${line}`);
      return false;
    },
    { maxAttempts: 60, delayMs: 10_000 },
  );
}

/** Verify required tools are installed on remote, auto-install missing ones. */
async function verifyRemoteTools(
  key: string, ip: string, onLog: (msg: string) => void,
): Promise<void> {
  onLog("Verifying tools...");
  for (const { name, test, fix } of REQUIRED_TOOLS) {
    const { exitCode } = await sshExecAsync(key, ip, test, { timeout: 10_000 });
    if (exitCode !== 0) {
      onLog(`${name} missing — installing...`);
      await sshExecAsync(key, ip, fix, { timeout: 120_000 });
      const { exitCode: verify } = await sshExecAsync(key, ip, test, { timeout: 10_000 });
      if (verify !== 0) {
        onLog(`WARNING: ${name} installation failed`);
      } else {
        onLog(`${name} installed`);
      }
    } else {
      onLog(`${name} ✓`);
    }
  }
}

/** Sync credentials and Claude auth to remote host. */
async function syncRemoteCredentials(
  key: string, ip: string, computeName: string, onLog: (msg: string) => void,
): Promise<void> {
  onLog("Syncing credentials...");
  try {
    await syncToHost(key, ip, { direction: "push", onLog });
  } catch (e: any) {
    onLog(`Credential sync failed: ${e?.message ?? e}`);
  }

  // Set up Claude auth on remote
  const hasAuth = !!process.env.CLAUDE_CODE_OAUTH_TOKEN
    || !!process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
    || !!process.env.ANTHROPIC_API_KEY;
  if (!hasAuth) {
    onLog("⚠ No Claude auth — run 'ark auth', set CLAUDE_CODE_OAUTH_TOKEN, then restart");
  } else {
    // Credentials exist locally — verify they synced to remote
    const { exitCode: authCheck } = await sshExecAsync(key, ip,
      "test -f ~/.claude/.credentials.json",
      { timeout: 10_000 });
    if (authCheck === 0) {
      onLog("Claude credentials synced ✓");
    } else {
      // Re-sync just the credentials file
      onLog("Re-syncing Claude credentials...");
      try {
        const { execFileAsync: efa } = await import("child_process").then(m => ({ execFileAsync: promisify(m.execFile) }));
        const localCredFile = join(homedir(), ".claude", ".credentials.json");
        await efa("scp", [
          "-i", key, "-o", "StrictHostKeyChecking=no",
          localCredFile, `${REMOTE_USER}@${ip}:${REMOTE_HOME}/.claude/.credentials.json`,
        ], { timeout: 15_000 });
        onLog("Claude credentials synced ✓");
      } catch (e: any) {
        console.error(`[ec2] syncRemoteCredentials: scp credentials to ${computeName} failed:`, e?.message ?? e);
        onLog("Failed to sync credentials — run 'ark auth --host " + computeName + "'");
      }
    }
  }
}

// ── Extracted helpers for launch() ───────────────────────────────────────────

/** Upload MCP config, hooks config, and sync project files to remote clone. */
async function uploadSessionConfigs(
  key: string, ip: string, remoteWorkdir: string, opts: LaunchOpts,
): Promise<void> {
  const localMcpJson = join(opts.workdir, ".mcp.json");
  if (existsSync(localMcpJson)) {
    const encoded = Buffer.from(readFileSync(localMcpJson, "utf-8")).toString("base64");
    await sshExecAsync(key, ip,
      `echo '${encoded}' | base64 -d > ${remoteWorkdir}/.mcp.json`,
      { timeout: 15_000 });
  }
  const localHooksConfig = join(opts.workdir, ".claude", "settings.local.json");
  if (existsSync(localHooksConfig)) {
    const encoded = Buffer.from(readFileSync(localHooksConfig, "utf-8")).toString("base64");
    await sshExecAsync(key, ip,
      `mkdir -p ${remoteWorkdir}/.claude && echo '${encoded}' | base64 -d > ${remoteWorkdir}/.claude/settings.local.json`,
      { timeout: 15_000 });
  }

  // Sync .claude/commands/ if it exists
  const commandsDir = join(opts.workdir, ".claude", "commands");
  if (existsSync(commandsDir)) {
    await sshExecAsync(key, ip, `mkdir -p ${remoteWorkdir}/.claude/commands`, { timeout: 15_000 });
    await rsyncPush(key, ip, commandsDir + "/", `${remoteWorkdir}/.claude/commands/`);
  }

  // Sync .claude/skills/ if it exists
  const skillsDir = join(opts.workdir, ".claude", "skills");
  if (existsSync(skillsDir)) {
    await sshExecAsync(key, ip, `mkdir -p ${remoteWorkdir}/.claude/skills`, { timeout: 15_000 });
    await rsyncPush(key, ip, skillsDir + "/", `${remoteWorkdir}/.claude/skills/`);
  }

  // Sync CLAUDE.md if it exists
  const claudeMd = join(opts.workdir, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    const encoded = Buffer.from(readFileSync(claudeMd, "utf-8")).toString("base64");
    await sshExecAsync(key, ip,
      `echo '${encoded}' | base64 -d > ${remoteWorkdir}/CLAUDE.md`,
      { timeout: 15_000 });
  }

  // Sync project files from arc.json
  const { parseArcJson } = await import("../../arc-json.js");
  const arcJson = opts.workdir ? parseArcJson(opts.workdir) : null;
  if (arcJson?.sync?.length && opts.workdir) {
    await syncProjectFiles(key, ip, arcJson.sync, opts.workdir, remoteWorkdir);
  }
}

/** Rewrite launcher script for remote paths and upload it. */
async function setupRemoteLauncher(
  key: string, ip: string, session: Session, remoteWorkdir: string, opts: LaunchOpts,
): Promise<void> {
  let remoteLauncher = opts.launcherContent;
  if (opts.workdir) {
    const escaped = opts.workdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    remoteLauncher = remoteLauncher.replace(new RegExp(escaped, 'g'), remoteWorkdir);
  }
  remoteLauncher = remoteLauncher.replace(/^cd .*$/m, `cd '${remoteWorkdir}'`);

  const encoded = Buffer.from(remoteLauncher).toString("base64");
  const remoteDir = `~/.ark/tracks/${session.id}`;
  await sshExecAsync(key, ip,
    `mkdir -p ${remoteDir} && echo '${encoded}' | base64 -d > ${remoteDir}/launch.sh && chmod +x ${remoteDir}/launch.sh`,
    { timeout: 15_000 });
}

/** Set up channel forward tunnel and reverse tunnel to conductor. */
async function setupSessionTunnels(
  key: string, ip: string, session: Session, opts: LaunchOpts,
): Promise<void> {
  const channelPort = sessionChannelPort(session.id);
  const channelPortDecl: PortDecl = { port: channelPort, name: "channel", source: "ark" };
  setupTunnels(key, ip, [...opts.ports, channelPortDecl]);
  setupReverseTunnel(key, ip, 19100);
}

export class EC2Provider implements ComputeProvider {
  readonly name = "ec2";
  readonly isolationModes = [
    { value: "inplace", label: "Remote checkout (in-place)" },
  ];

  readonly canReboot = true;
  readonly canDelete = true;
  readonly supportsWorktree = false;
  readonly initialStatus = "stopped";
  readonly needsAuth = true;

  private queues = new Map<string, SSHQueue>();

  /** Get or create the pool + queue for a compute host. */
  private getQueue(compute: Compute): { pool: SSHPool; queue: SSHQueue } {
    const cfg = compute.config as EC2HostConfig;
    if (!cfg.ip) throw new Error(`Compute '${compute.name}' has no IP`);
    const key = sshKeyPath(compute.name);
    const pool = getOrCreatePool(compute.name, key, cfg.ip);
    if (!this.queues.has(compute.name)) {
      this.queues.set(compute.name, new SSHQueue(pool));
    }
    return { pool, queue: this.queues.get(compute.name)! };
  }

  async provision(compute: Compute, opts?: ProvisionOpts): Promise<void> {
    const log = opts?.onLog ?? (() => {});
    const cfg = compute.config as EC2HostConfig;
    updateCompute(compute.name, { status: "provisioning" });

    // Ensure Pulumi CLI is available (auto-installs if missing)
    await ensurePulumi(log);

    // Generate SSH key pair for this compute
    log("Generating SSH key pair...");
    const { privateKeyPath } = await generateSshKey(compute.name);

    // Build cloud-init user data
    log("Building cloud-init script...");
    const userData = buildUserData({
      idleMinutes: cfg.idle_minutes ?? 60,
    });

    // Provision via Pulumi
    log("Creating Pulumi stack...");
    const result = await provisionStack(compute.name, {
      size: opts?.size ?? cfg.size ?? "m",
      arch: opts?.arch ?? cfg.arch ?? "x64",
      region: cfg.region ?? "us-east-1",
      subnetId: cfg.subnet_id,
      securityGroupId: cfg.sg_id,
      awsProfile: cfg.aws_profile,
      userData,
      tags: opts?.tags ?? cfg.tags,
      sshKeyPath: privateKeyPath,
      onOutput: (msg) => {
        // Filter Pulumi output - show resource creation events
        if (msg.includes("creating") || msg.includes("created") || msg.includes("updated")) {
          log(`Pulumi: ${msg.slice(0, 120)}`);
        }
      },
    });

    // Update compute with runtime state
    log(`Instance ${result.instance_id} launched (IP: ${result.ip ?? "pending"})`);
    updateCompute(compute.name, { status: "running" });
    mergeComputeConfig(compute.name, result as unknown as Record<string, unknown>);

    // Store hourly rate for cost tracking
    const instanceType = resolveInstanceType(
      opts?.size ?? cfg.size ?? "m",
      opts?.arch ?? cfg.arch ?? "x64",
    );
    const rate = hourlyRate(instanceType);
    if (rate > 0) {
      mergeComputeConfig(compute.name, { hourlyRate: rate });
      log(`Cost: $${rate.toFixed(3)}/hr (~$${(rate * 24).toFixed(2)}/day)`);
    }

    // Wait for SSH
    if (result.ip) {
      log(`Waiting for SSH...`);
      const sshOk = await poll(
        async () => {
          const res = await sshExecAsync(privateKeyPath, result.ip!, "echo ok", { timeout: 15_000 });
          return res.exitCode === 0;
        },
        {
          maxAttempts: 30,
          delayMs: 5000,
          onRetry: (attempt) => log(`SSH attempt ${attempt}/30...`),
        },
      );
      log(sshOk ? "SSH ready" : "SSH failed after 30 attempts");

      // Poll cloud-init, verify tools, sync credentials
      if (sshOk) {
        const key = sshKeyPath(compute.name);
        await waitForCloudInit(key, result.ip!, compute.name, log);
        await verifyRemoteTools(key, result.ip!, log);
        await syncRemoteCredentials(key, result.ip!, compute.name, log);
      }
    }
  }

  async destroy(compute: Compute): Promise<void> {
    await destroyPool(compute.name);
    this.queues.delete(compute.name);
    const cfg = compute.config as EC2HostConfig;
    await destroyStack(compute.name, {
      region: cfg.region ?? "us-east-1",
      stackName: cfg.stack_name,
      awsProfile: cfg.aws_profile,
    });
    updateCompute(compute.name, { status: "destroyed" });
    mergeComputeConfig(compute.name, { instance_id: null, ip: null });
  }

  async start(compute: Compute): Promise<void> {
    const cfg = compute.config as EC2HostConfig;
    const instanceId = cfg.instance_id;
    if (!instanceId) throw new Error(`Compute '${compute.name}' has no instance_id`);

    const ec2 = createEc2Client(cfg);
    await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));

    // Wait for running state and get IP
    let ip: string | null = null;
    await poll(
      async () => {
        const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId!] }));
        const inst = desc.Reservations?.[0]?.Instances?.[0];
        if (inst?.State?.Name === "running") {
          ip = inst.PublicIpAddress ?? inst.PrivateIpAddress ?? null;
          return true;
        }
        return false;
      },
      { maxAttempts: 60, delayMs: 5000 },
    );

    updateCompute(compute.name, { status: "running" });
    mergeComputeConfig(compute.name, { ip });

    if (ip) {
      const key = sshKeyPath(compute.name);
      await waitForSshAsync(key, ip);
    }
  }

  async stop(compute: Compute): Promise<void> {
    // Destroy pool before stopping — master socket won't survive
    await destroyPool(compute.name);
    this.queues.delete(compute.name);

    const cfg = compute.config as EC2HostConfig;
    const instanceId = cfg.instance_id;
    if (!instanceId) throw new Error(`Compute '${compute.name}' has no instance_id`);

    const ec2 = createEc2Client(cfg);
    await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));

    await poll(
      async () => {
        const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId!] }));
        return desc.Reservations?.[0]?.Instances?.[0]?.State?.Name === "stopped";
      },
      { maxAttempts: 60, delayMs: 5000 },
    );

    updateCompute(compute.name, { status: "stopped" });
    mergeComputeConfig(compute.name, { ip: null });
  }

  async reboot(compute: Compute, opts?: { onLog?: (msg: string) => void; onProgress?: (msg: string) => void }): Promise<void> {
    const log = opts?.onLog ?? (() => {});
    const progress = opts?.onProgress ?? (() => {});
    const cfg = compute.config as EC2HostConfig;
    const instanceId = cfg.instance_id;
    if (!instanceId) throw new Error(`Compute '${compute.name}' has no instance_id`);

    const ec2 = createEc2Client(cfg);
    await ec2.send(new RebootInstancesCommand({ InstanceIds: [instanceId] }));
    log("Reboot initiated — waiting for host...");

    // Wait up to 3 minutes for SSH to come back
    const deadline = Date.now() + REBOOT_TIMEOUT_MS;
    let attempt = 0;
    let currentIp = cfg.ip;
    while (Date.now() < deadline) {
      attempt++;
      progress(`Rebooting ${compute.name} (${attempt}...)`);
      await sleep(10_000);

      // Check if IP changed (stop/start assigns new IP)
      const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      const inst = desc.Reservations?.[0]?.Instances?.[0];
      const newIp = inst?.PublicIpAddress;
      if (newIp && newIp !== currentIp) {
        mergeComputeConfig(compute.name, { ip: newIp });
        log(`IP changed: ${currentIp} → ${newIp}`);
        currentIp = newIp;
      }

      if (!currentIp) continue;
      const { exitCode } = await sshExecAsync(sshKeyPath(compute.name), currentIp, "echo ok", { timeout: 10_000 });
      if (exitCode === 0) {
        log("Host is back online");
        updateCompute(compute.name, { status: "running" });
        return;
      }
    }

    // Timed out
    log("Host did not come back after 3 minutes");
    updateCompute(compute.name, { status: "stopped" });
    mergeComputeConfig(compute.name, { last_error: "Reboot timeout — host unreachable" });
  }

  async launch(compute: Compute, session: Session, opts: LaunchOpts): Promise<string> {
    const cfg = compute.config as EC2HostConfig;
    const ip = cfg.ip;
    if (!ip) throw new Error(`Compute '${compute.name}' has no IP`);
    const key = sshKeyPath(compute.name);

    // 1. Resolve repo URL + clone on remote
    const repoUrl = await resolveRepoUrl(session.repo ?? opts.workdir);
    if (!repoUrl) throw new Error("Cannot determine git repo URL. Provide org/repo or a git repo path.");
    const repoName = getRepoName(repoUrl);
    const remoteWorkdir = await cloneRepoOnRemote(key, ip, repoUrl, repoName, {
      branch: session.branch ?? undefined,
      sessionId: session.id,
    });

    // 2. Upload configs + project files
    await uploadSessionConfigs(key, ip, remoteWorkdir, opts);

    // 3. Trust remote directory
    await trustRemoteDirectory(key, ip, remoteWorkdir);

    // 4. Build + upload launcher, create tmux session
    await setupRemoteLauncher(key, ip, session, remoteWorkdir, opts);
    const remoteDir = `~/.ark/tracks/${session.id}`;
    await sshExecAsync(key, ip,
      `tmux new-session -d -s ${opts.tmuxName} -c ${remoteWorkdir} 'bash ${remoteDir}/launch.sh'`,
      { timeout: 15_000 });

    // 5. Auto-accept channel prompt
    await autoAcceptChannelPrompt(key, ip, opts.tmuxName);

    // 6. Setup tunnels (forward + reverse)
    await setupSessionTunnels(key, ip, session, opts);

    // 7. Store remote workdir in session config for display
    const { updateSession } = await import("../../../core/store.js");
    updateSession(session.id, {
      config: { ...(session.config ?? {}), remoteWorkdir },
    });

    return opts.tmuxName;
  }

  // ── Session lifecycle ─────────────────────────────────────────────────

  async killAgent(compute: Compute, session: Session): Promise<void> {
    if (!session.session_id) return;
    try {
      const { queue } = this.getQueue(compute);
      await queue.command(async (p) => {
        await p.exec(`tmux kill-session -t '${session.session_id}'`, { timeout: 10_000 });
      });
    } catch (e: any) {
      // Session may already be dead or host unreachable
      console.error(`[ec2] killAgent: tmux kill-session '${session.session_id}' on ${compute.name} failed:`, e?.message ?? e);
    }
  }

  async captureOutput(compute: Compute, session: Session, opts?: { lines?: number }): Promise<string> {
    if (!session.session_id) return "";
    try {
      const { queue } = this.getQueue(compute);
      const lines = opts?.lines ?? 50;
      return await queue.command(async (p) => {
        const { stdout } = await p.exec(
          `tmux capture-pane -t '${session.session_id}' -p -S -${lines}`,
          { timeout: 10_000 },
        );
        return stdout;
      });
    } catch (e: any) {
      console.error(`[ec2] captureOutput: tmux capture-pane '${session.session_id}' on ${compute.name} failed:`, e?.message ?? e);
      return "";
    }
  }

  async cleanupSession(compute: Compute, session: Session): Promise<void> {
    const remoteWorkdir = (session.config as SessionConfig)?.remoteWorkdir;
    if (!remoteWorkdir) return;
    try {
      const { queue } = this.getQueue(compute);
      await queue.command(async (p) => {
        await p.exec(`rm -rf '${remoteWorkdir}'`, { timeout: 15_000 });
      });
    } catch (e: any) {
      // Best effort cleanup — remote may be unreachable
      console.error(`[ec2] cleanupSession: rm remote workdir for ${session.id} on ${compute.name} failed:`, e?.message ?? e);
    }
  }

  async attach(compute: Compute, session: Session): Promise<void> {
    const cfg = compute.config as EC2HostConfig;
    const ip = cfg.ip;
    if (!ip) return;
    const key = sshKeyPath(compute.name);

    // Re-establish tunnels from session's port list + channel port
    const ports: PortDecl[] = (session.config as SessionConfig)?.ports ?? [];
    const channelPort = sessionChannelPort(session.id);
    const channelPortDecl: PortDecl = { port: channelPort, name: "channel", source: "ark" };
    setupTunnels(key, ip, [...ports, channelPortDecl]);

    // Re-establish reverse tunnel for conductor
    setupReverseTunnel(key, ip, 19100);
  }

  async checkStatus(compute: Compute): Promise<string | null> {
    const cfg = compute.config as EC2HostConfig;
    const instanceId = cfg.instance_id;
    if (!instanceId) return "destroyed";

    const ec2 = createEc2Client(cfg);
    try {
      const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      const state = desc.Reservations?.[0]?.Instances?.[0]?.State?.Name;
      if (!state) return "destroyed";

      // Map AWS states to ark statuses
      if (state === "terminated" || state === "shutting-down") return "destroyed";
      if (state === "stopped" || state === "stopping") return "stopped";
      if (state === "running") return "running";
      if (state === "pending") return "provisioning";
      return state;
    } catch (e: any) {
      // InvalidInstanceID.NotFound means the instance is gone
      if (e?.name === "InvalidInstanceID.NotFound" || e?.Code === "InvalidInstanceID.NotFound") {
        return "destroyed";
      }
      return null; // can't determine — network error etc
    }
  }

  /** Populates all ComputeSnapshot fields: metrics, sessions, processes, docker (via SSH_FAST_CMD). */
  async getMetrics(compute: Compute): Promise<ComputeSnapshot> {
    const cfg = compute.config as EC2HostConfig;
    if (!cfg.ip) throw new Error(`Compute '${compute.name}' has no IP`);
    const { queue } = this.getQueue(compute);

    // Periodically refresh auth token on remote (piggyback on metrics cycle)
    if (process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN) {
      queue.command(async (p) => {
        const token = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN!;
        await p.exec(
          `for sess in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^ark-'); do tmux set-environment -t "$sess" CLAUDE_CODE_SESSION_ACCESS_TOKEN '${token}' 2>/dev/null; done`,
          { timeout: 10_000 },
        );
      }).catch((e: any) => {
      console.error(`[ec2] getMetrics: token refresh on ${compute.name} failed:`, e?.message ?? e);
    }); // fire-and-forget
    }

    const result = await queue.metrics(async (p) => {
      const { stdout } = await p.exec(SSH_FAST_CMD, { timeout: 15_000 });
      return parseSnapshot(stdout);
    });
    if (!result) throw new Error("Metrics poll skipped (previous still in flight)");
    return result;
  }

  async probePorts(compute: Compute, ports: PortDecl[]): Promise<PortStatus[]> {
    const cfg = compute.config as EC2HostConfig;
    if (!cfg.ip) return ports.map(pd => ({ ...pd, listening: false }));
    const { queue } = this.getQueue(compute);
    return queue.command(async (p) => {
      const { stdout } = await p.exec("ss -tln", { timeout: 15_000 });
      if (!stdout) return ports.map(pd => ({ ...pd, listening: false }));
      return ports.map(pd => ({
        ...pd,
        listening: stdout.includes(`:${pd.port} `),
      }));
    });
  }

  async syncEnvironment(compute: Compute, opts: SyncOpts): Promise<void> {
    const { queue } = this.getQueue(compute);
    await queue.sync(async () => {
      const cfg = compute.config as EC2HostConfig;
      const key = sshKeyPath(compute.name);
      await syncToHost(key, cfg.ip!, {
        direction: opts.direction,
        categories: opts.categories,
        onLog: opts.onLog,
      });

      if (opts.projectFiles?.length && opts.projectDir) {
        await syncProjectFiles(
          key,
          cfg.ip!,
          opts.projectFiles,
          opts.projectDir,
          `${REMOTE_HOME}/Projects/${opts.projectDir.split("/").pop()}`,
        );
      }
    });
  }

  async checkSession(compute: Compute, tmuxSessionId: string): Promise<boolean> {
    try {
      const { queue } = this.getQueue(compute);
      return await queue.command(async (p) => {
        const { exitCode } = await p.exec(
          `tmux has-session -t '${tmuxSessionId}'`, { timeout: 10_000 });
        return exitCode === 0;
      });
    } catch (e: any) {
      console.error(`[ec2] checkSession: tmux has-session '${tmuxSessionId}' on ${compute.name} failed:`, e?.message ?? e);
      return false;
    }
  }

  getAttachCommand(compute: Compute, session: Session): string[] {
    const cfg = compute.config as EC2HostConfig;
    if (!cfg?.ip || !session.session_id) return [];
    return [
      "ssh", "-i", sshKeyPath(compute.name),
      "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10", "-t",
      `${REMOTE_USER}@${cfg.ip}`, `tmux attach -t ${session.session_id}`,
    ];
  }

  buildChannelConfig(sessionId: string, stage: string, channelPort: number, opts?: { conductorUrl?: string }): Record<string, unknown> {
    return {
      command: `${REMOTE_HOME}/.ark/bin/ark`,
      args: ["channel"],
      env: {
        ARK_SESSION_ID: sessionId,
        ARK_STAGE: stage,
        ARK_CHANNEL_PORT: String(channelPort),
        ARK_CONDUCTOR_URL: opts?.conductorUrl ?? "http://localhost:19100",
      },
    };
  }

  buildLaunchEnv(_session: Session): Record<string, string> {
    const env: Record<string, string> = {};
    const token = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN;
    if (token) env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = token;
    let oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!oauthToken) {
      try {
        const { existsSync: ex, readFileSync: rf } = require("fs");
        const { join: j } = require("path");
        const { ARK_DIR } = require("../../../core/store.js");
        const p = j(ARK_DIR(), "claude-oauth-token");
        if (ex(p)) oauthToken = rf(p, "utf-8").trim();
      } catch (e: any) {
        console.error('[ec2] buildLaunchEnv: failed to read claude-oauth-token:', e?.message ?? e);
      }
    }
    if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    return env;
  }
}

/**
 * EC2 compute provider - implements ComputeProvider for AWS EC2 instances.
 *
 * Ties together all EC2 modules: SSH, cloud-init, sync, metrics, ports.
 * Provision/destroy are stubbed until the Pulumi-based provision module lands.
 */

import {
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
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
import { updateCompute, mergeComputeConfig } from "../../../core/store.js";
import { sshKeyPath, sshExec, sshExecAsync, waitForSsh, waitForSshAsync, generateSshKey } from "./ssh.js";
import { buildUserData } from "./cloud-init.js";
import { provisionStack, destroyStack, resolveInstanceType, ensurePulumi } from "./provision.js";
import { syncToHost, syncProjectFiles } from "./sync.js";
import { fetchMetrics, fetchMetricsAsync } from "./metrics.js";
import { setupTunnels, setupReverseTunnel, probeRemotePorts } from "./ports.js";
import { hourlyRate } from "./cost.js";
import { sleep, poll } from "../../util.js";
import { resolveRepoUrl, getRepoName, cloneRepoOnRemote, trustRemoteDirectory, autoAcceptChannelPrompt } from "./remote-setup.js";

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

export class EC2Provider implements ComputeProvider {
  readonly name = "ec2";

  async provision(compute: Compute, opts?: ProvisionOpts): Promise<void> {
    const log = opts?.onLog ?? (() => {});
    const cfg = compute.config as EC2HostConfig;
    updateCompute(compute.name, { status: "provisioning" });

    // Ensure Pulumi CLI is available (auto-installs if missing)
    ensurePulumi(log);

    // Generate SSH key pair for this compute
    log("Generating SSH key pair...");
    const { privateKeyPath } = generateSshKey(compute.name);

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

      // Poll cloud-init status
      if (sshOk) {
        log("Waiting for cloud-init to complete...");
        const key = sshKeyPath(compute.name);
        await poll(
          async () => {
            const { stdout } = await sshExecAsync(key, result.ip!, "cat /home/ubuntu/.ark-ready 2>/dev/null || echo 'not ready'", { timeout: 15_000 });
            if (stdout.trim().includes("provisioning complete")) {
              log("Cloud-init complete - all packages installed");
              mergeComputeConfig(compute.name, { cloud_init_done: true });
              return true;
            }
            const { stdout: progress } = await sshExecAsync(key, result.ip!,
              "tail -1 /var/log/cloud-init-output.log 2>/dev/null || echo 'waiting...'", { timeout: 15_000 });
            const line = progress.trim().slice(0, 100);
            if (line && line !== "waiting...") log(`cloud-init: ${line}`);
            return false;
          },
          { maxAttempts: 60, delayMs: 10_000 },
        );
      }
    }
  }

  async destroy(compute: Compute): Promise<void> {
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

  async launch(compute: Compute, session: Session, opts: LaunchOpts): Promise<string> {
    const cfg = compute.config as EC2HostConfig;
    const ip = cfg.ip;
    if (!ip) throw new Error(`Compute '${compute.name}' has no IP`);
    const key = sshKeyPath(compute.name);

    // 1. Resolve repo URL
    const repoUrl = resolveRepoUrl(session.repo ?? opts.workdir);
    if (!repoUrl) throw new Error("Cannot determine git repo URL. Provide org/repo or a git repo path.");
    const repoName = getRepoName(repoUrl);

    // 2. Clone on remote
    const remoteWorkdir = await cloneRepoOnRemote(key, ip, repoUrl, repoName, {
      branch: session.branch ?? undefined,
      sessionId: session.id,
    });

    // 3. Sync project files from arc.json
    const { parseArcJson } = await import("../../arc-json.js");
    const arcJson = opts.workdir ? parseArcJson(opts.workdir) : null;
    if (arcJson?.sync?.length && opts.workdir) {
      syncProjectFiles(key, ip, arcJson.sync, opts.workdir, remoteWorkdir);
    }

    // 4. Trust remote directory
    await trustRemoteDirectory(key, ip, remoteWorkdir);

    // 5. Build launcher with REMOTE paths
    let remoteLauncher = opts.launcherContent;
    if (opts.workdir) {
      // Replace all occurrences of the local workdir with the remote one
      const escaped = opts.workdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      remoteLauncher = remoteLauncher.replace(new RegExp(escaped, 'g'), remoteWorkdir);
    }
    // Also fix the cd command to use remote path
    remoteLauncher = remoteLauncher.replace(/^cd .*$/m, `cd '${remoteWorkdir}'`);

    // 6. Upload launcher
    const encoded = Buffer.from(remoteLauncher).toString("base64");
    const remoteDir = `~/.ark/tracks/${session.id}`;
    await sshExecAsync(key, ip,
      `mkdir -p ${remoteDir} && echo '${encoded}' | base64 -d > ${remoteDir}/launch.sh && chmod +x ${remoteDir}/launch.sh`,
      { timeout: 15_000 });

    // 7. Create remote tmux session
    await sshExecAsync(key, ip,
      `tmux new-session -d -s ${opts.tmuxName} -c ${remoteWorkdir} 'bash ${remoteDir}/launch.sh'`,
      { timeout: 15_000 });

    // 8. Auto-accept channel prompt
    await autoAcceptChannelPrompt(key, ip, opts.tmuxName);

    // 9. Setup port tunnels (local forward for app ports)
    if (opts.ports.length > 0) {
      setupTunnels(key, ip, opts.ports);
    }

    // 10. Reverse tunnel: let remote channel reach local conductor
    setupReverseTunnel(key, ip, 19100);

    // 11. Store remote workdir in session config for display
    const { updateSession } = await import("../../../core/store.js");
    updateSession(session.id, {
      config: { ...(session.config ?? {}), remoteWorkdir },
    });

    return opts.tmuxName;
  }

  async attach(compute: Compute, session: Session): Promise<void> {
    const cfg = compute.config as EC2HostConfig;
    const ip = cfg.ip;
    if (!ip) return;
    const key = sshKeyPath(compute.name);

    // Re-establish tunnels from session's port list
    const ports: PortDecl[] = (session.config as any)?.ports ?? [];
    if (ports.length > 0) {
      setupTunnels(key, ip, ports);
    }

    // Re-establish reverse tunnel for conductor
    setupReverseTunnel(key, ip, 19100);
  }

  async getMetrics(compute: Compute): Promise<ComputeSnapshot> {
    const cfg = compute.config as EC2HostConfig;
    const ip = cfg.ip;
    if (!ip) throw new Error(`Compute '${compute.name}' has no IP`);
    return fetchMetricsAsync(sshKeyPath(compute.name), ip);
  }

  async probePorts(compute: Compute, ports: PortDecl[]): Promise<PortStatus[]> {
    const cfg = compute.config as EC2HostConfig;
    const ip = cfg.ip;
    if (!ip) return ports.map((p) => ({ ...p, listening: false }));
    return probeRemotePorts(sshKeyPath(compute.name), ip, ports);
  }

  async syncEnvironment(compute: Compute, opts: SyncOpts): Promise<void> {
    const cfg = compute.config as EC2HostConfig;
    const ip = cfg.ip;
    if (!ip) throw new Error(`Compute '${compute.name}' has no IP`);
    const key = sshKeyPath(compute.name);

    syncToHost(key, ip, {
      direction: opts.direction,
      categories: opts.categories,
    });

    if (opts.projectFiles?.length && opts.projectDir) {
      syncProjectFiles(
        key,
        ip,
        opts.projectFiles,
        opts.projectDir,
        `/home/ubuntu/Projects/${opts.projectDir.split("/").pop()}`,
      );
    }
  }
}

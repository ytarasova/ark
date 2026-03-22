/**
 * EC2 compute provider — implements ComputeProvider for AWS EC2 instances.
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
import type {
  ComputeProvider,
  ProvisionOpts,
  LaunchOpts,
  SyncOpts,
  HostSnapshot,
  PortDecl,
  PortStatus,
} from "../../types.js";
import type { Host, Session } from "../../../core/store.js";
import { updateHost } from "../../../core/store.js";
import { sshKeyPath, sshExec, waitForSsh, generateSshKey } from "./ssh.js";
import { buildUserData } from "./cloud-init.js";
import { provisionStack, destroyStack, resolveInstanceType } from "./provision.js";
import { syncToHost, syncProjectFiles } from "./sync.js";
import { fetchMetrics } from "./metrics.js";
import { setupTunnels, probeRemotePorts } from "./ports.js";
import { hourlyRate } from "./cost.js";

export class EC2Provider implements ComputeProvider {
  readonly name = "ec2";

  async provision(host: Host, opts?: ProvisionOpts): Promise<void> {
    updateHost(host.name, { status: "provisioning" });

    // Generate SSH key pair for this host
    const { privateKeyPath } = generateSshKey(host.name);

    // Build cloud-init user data
    const userData = buildUserData({
      idleMinutes: (host.config as any)?.idle_minutes ?? 60,
    });

    // Provision via Pulumi
    const result = await provisionStack(host.name, {
      size: opts?.size ?? (host.config as any)?.size ?? "m",
      arch: opts?.arch ?? (host.config as any)?.arch ?? "x64",
      region: (host.config as any)?.region ?? "us-east-1",
      subnetId: (host.config as any)?.subnet_id,
      securityGroupId: (host.config as any)?.sg_id,
      userData,
      tags: opts?.tags ?? (host.config as any)?.tags,
      sshKeyPath: privateKeyPath,
    });

    // Update host with runtime state
    updateHost(host.name, {
      status: "running",
      config: { ...host.config, ...result },
    });

    // Store hourly rate for cost tracking
    const instanceType = resolveInstanceType(
      opts?.size ?? (host.config as any)?.size ?? "m",
      opts?.arch ?? (host.config as any)?.arch ?? "x64",
    );
    const rate = hourlyRate(instanceType);
    if (rate > 0) {
      updateHost(host.name, {
        config: { ...host.config, ...result, hourlyRate: rate },
      });
    }

    // Wait for SSH
    if (result.ip) {
      waitForSsh(privateKeyPath, result.ip);
    }
  }

  async destroy(host: Host): Promise<void> {
    await destroyStack(host.name, {
      region: (host.config as any)?.region ?? "us-east-1",
      stackName: (host.config as any)?.stack_name,
    });
    updateHost(host.name, {
      status: "destroyed",
      config: { ...host.config, instance_id: null, ip: null },
    });
  }

  async start(host: Host): Promise<void> {
    const instanceId = (host.config as any)?.instance_id;
    if (!instanceId) throw new Error(`Host '${host.name}' has no instance_id`);

    const ec2 = new EC2Client({
      region: (host.config as any)?.region ?? "us-east-1",
    });
    await ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));

    // Wait for running state and get new IP
    let ip: string | null = null;
    for (let i = 0; i < 60; i++) {
      const desc = await ec2.send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
      );
      const inst = desc.Reservations?.[0]?.Instances?.[0];
      if (inst?.State?.Name === "running") {
        ip = inst.PublicIpAddress ?? inst.PrivateIpAddress ?? null;
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    updateHost(host.name, { status: "running", config: { ...host.config, ip } });

    if (ip) {
      const key = sshKeyPath(host.name);
      waitForSsh(key, ip);
    }
  }

  async stop(host: Host): Promise<void> {
    const instanceId = (host.config as any)?.instance_id;
    if (!instanceId) throw new Error(`Host '${host.name}' has no instance_id`);

    const ec2 = new EC2Client({
      region: (host.config as any)?.region ?? "us-east-1",
    });
    await ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));

    // Wait for stopped state
    for (let i = 0; i < 60; i++) {
      const desc = await ec2.send(
        new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
      );
      if (desc.Reservations?.[0]?.Instances?.[0]?.State?.Name === "stopped") {
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    updateHost(host.name, {
      status: "stopped",
      config: { ...host.config, ip: null },
    });
  }

  async launch(host: Host, session: Session, opts: LaunchOpts): Promise<string> {
    const ip = (host.config as any)?.ip;
    if (!ip) throw new Error(`Host '${host.name}' has no IP`);
    const key = sshKeyPath(host.name);

    // Create remote directory for this session
    const remoteDir = `~/.ark/tracks/${session.id}`;
    sshExec(key, ip, `mkdir -p ${remoteDir}`);

    // Write launcher script to remote host
    sshExec(
      key,
      ip,
      `cat > ${remoteDir}/launch.sh << 'LAUNCHER'\n${opts.launcherContent}\nLAUNCHER`,
    );
    sshExec(key, ip, `chmod +x ${remoteDir}/launch.sh`);

    // Start remote tmux session running the launcher
    sshExec(
      key,
      ip,
      `tmux new-session -d -s ${opts.tmuxName} 'bash ${remoteDir}/launch.sh'`,
    );

    // Setup port tunnels if any ports are declared
    if (opts.ports.length > 0) {
      setupTunnels(key, ip, opts.ports);
    }

    return opts.tmuxName;
  }

  async attach(host: Host, session: Session): Promise<void> {
    const ip = (host.config as any)?.ip;
    if (!ip) return;
    const key = sshKeyPath(host.name);

    // Re-establish tunnels from session's port list
    const ports: PortDecl[] = (session.config as any)?.ports ?? [];
    if (ports.length > 0) {
      setupTunnels(key, ip, ports);
    }
  }

  async getMetrics(host: Host): Promise<HostSnapshot> {
    const ip = (host.config as any)?.ip;
    if (!ip) throw new Error(`Host '${host.name}' has no IP`);
    return fetchMetrics(sshKeyPath(host.name), ip);
  }

  async probePorts(host: Host, ports: PortDecl[]): Promise<PortStatus[]> {
    const ip = (host.config as any)?.ip;
    if (!ip) return ports.map((p) => ({ ...p, listening: false }));
    return probeRemotePorts(sshKeyPath(host.name), ip, ports);
  }

  async syncEnvironment(host: Host, opts: SyncOpts): Promise<void> {
    const ip = (host.config as any)?.ip;
    if (!ip) throw new Error(`Host '${host.name}' has no IP`);
    const key = sshKeyPath(host.name);

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

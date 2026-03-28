/**
 * Remote compute providers - all 4 isolation modes running on EC2.
 *
 * Each extends ArkdBackedProvider and talks to arkd on the remote instance.
 * EC2 provisioning, SSH setup, and cloud-init are shared via RemoteArkdBase.
 * After provisioning, all operations go through ArkdClient - no more SSH pool/queue.
 *
 * Isolation is encoded in how the launcher script is structured + what
 * extra setup is done during provision (docker install, firecracker, etc.).
 */

import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { ArkdBackedProvider } from "./arkd-backed.js";
import type {
  Compute, Session, ProvisionOpts, SyncOpts, IsolationMode,
} from "../types.js";

const ARKD_REMOTE_PORT = 19300;

interface RemoteConfig {
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
  idle_minutes?: number;
  ingress_cidrs?: string[];
  tags?: Record<string, string>;
  arkd_url?: string;
  ssh_tunnel_port?: number;
  isolation?: string;
  container_name?: string;
  devcontainer_workdir?: string;
  image?: string;
  last_error?: string;
}

// ── Shared remote base ──────────────────────────────────────────────────────

abstract class RemoteArkdBase extends ArkdBackedProvider {
  readonly canReboot = true;
  readonly canDelete = true;
  readonly supportsWorktree = false;
  readonly initialStatus = "stopped";
  readonly needsAuth = true;

  /** Subclass isolation type label for cloud-init extras. */
  abstract readonly isolationType: string;

  getArkdUrl(compute: Compute): string {
    const cfg = compute.config as RemoteConfig;
    if (cfg.arkd_url) return cfg.arkd_url;
    if (cfg.ip) return `http://${cfg.ip}:${ARKD_REMOTE_PORT}`;
    throw new Error(`Compute '${compute.name}' has no IP or arkd_url`);
  }

  async provision(compute: Compute, opts?: ProvisionOpts): Promise<void> {
    const log = opts?.onLog ?? (() => {});
    const cfg = compute.config as RemoteConfig;
    const { updateCompute, mergeComputeConfig } = await import("../../core/store.js");
    updateCompute(compute.name, { status: "provisioning" });

    try {
      const { ensurePulumi, provisionStack, resolveInstanceType } = await import("./ec2/provision.js");
      const { generateSshKey } = await import("./ec2/ssh.js");
      const { buildUserData } = await import("./ec2/cloud-init.js");
      const { hourlyRate } = await import("./ec2/cost.js");
      const { poll } = await import("../util.js");

      await ensurePulumi(log);

      log("Generating SSH key pair...");
      const { privateKeyPath } = await generateSshKey(compute.name);

      log("Building cloud-init script with arkd...");
      const conductorUrl = process.env.ARK_CONDUCTOR_URL ?? `http://localhost:${process.env.ARK_CONDUCTOR_PORT ?? "19100"}`;
      const userData = buildUserDataWithArkd({
        idleMinutes: cfg.idle_minutes ?? 60,
        isolation: this.isolationType,
        conductorUrl,
      });

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
          if (msg.includes("creating") || msg.includes("created") || msg.includes("updated")) {
            log(`Pulumi: ${msg.slice(0, 120)}`);
          }
        },
      });

      log(`Instance ${result.instance_id} launched (IP: ${result.ip ?? "pending"})`);
      updateCompute(compute.name, { status: "running" });
      mergeComputeConfig(compute.name, {
        ...result as unknown as Record<string, unknown>,
        arkd_url: `http://${result.ip}:${ARKD_REMOTE_PORT}`,
      });

      // Store hourly rate
      const instanceType = resolveInstanceType(
        opts?.size ?? cfg.size ?? "m",
        opts?.arch ?? cfg.arch ?? "x64",
      );
      const rate = hourlyRate(instanceType);
      if (rate > 0) mergeComputeConfig(compute.name, { hourlyRate: rate });

      // Wait for SSH + cloud-init
      if (result.ip) {
        const { sshExecAsync } = await import("./ec2/ssh.js");
        log("Waiting for SSH...");
        await poll(
          async () => {
            const res = await sshExecAsync(privateKeyPath, result.ip!, "echo ok", { timeout: 15_000 });
            return res.exitCode === 0;
          },
          { maxAttempts: 30, delayMs: 5000 },
        );

        log("Waiting for cloud-init to finish...");
        await poll(
          async () => {
            const res = await sshExecAsync(privateKeyPath, result.ip!, "test -f /home/ubuntu/.ark-ready && echo ready", { timeout: 10_000 });
            return res.stdout.includes("ready");
          },
          { maxAttempts: 60, delayMs: 10_000 },
        );

        // Wait for arkd to be reachable
        log("Waiting for arkd...");
        const arkdUrl = `http://${result.ip}:${ARKD_REMOTE_PORT}`;
        await poll(
          async () => {
            try {
              const resp = await fetch(`${arkdUrl}/health`, { signal: AbortSignal.timeout(5000) });
              return resp.ok;
            } catch { return false; }
          },
          { maxAttempts: 30, delayMs: 3000 },
        );

        log("arkd is online.");

        // Post-provision isolation setup
        await this.postProvision(compute, log);
      }

      mergeComputeConfig(compute.name, { cloud_init_done: true });
    } catch (err) {
      const { mergeComputeConfig: mc, updateCompute: uc } = await import("../../core/store.js");
      mc(compute.name, { last_error: err instanceof Error ? err.message : String(err) });
      uc(compute.name, { status: "stopped" });
      throw err;
    }
  }

  /** Override in subclasses for isolation-specific post-provision setup. */
  async postProvision(_compute: Compute, _log: (msg: string) => void): Promise<void> {}

  async destroy(compute: Compute): Promise<void> {
    const { destroyStack } = await import("./ec2/provision.js");
    const { destroyPool } = await import("./ec2/pool.js");
    const { updateCompute } = await import("../../core/store.js");
    try {
      await destroyStack(compute.name);
      destroyPool(compute.name);
    } catch {}
    updateCompute(compute.name, { status: "destroyed" });
  }

  async start(compute: Compute): Promise<void> {
    const cfg = compute.config as RemoteConfig;
    if (!cfg.instance_id) throw new Error("No instance_id - cannot start");

    const { EC2Client, StartInstancesCommand, DescribeInstancesCommand } = await import("@aws-sdk/client-ec2");
    const { fromIni } = await import("@aws-sdk/credential-providers");
    const { updateCompute, mergeComputeConfig } = await import("../../core/store.js");
    const { poll } = await import("../util.js");

    const ec2 = new EC2Client({
      region: cfg.region ?? "us-east-1",
      ...(cfg.aws_profile ? { credentials: fromIni({ profile: cfg.aws_profile }) } : {}),
    });

    await ec2.send(new StartInstancesCommand({ InstanceIds: [cfg.instance_id] }));

    // Poll for public IP
    const ip = await poll(
      async () => {
        const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [cfg.instance_id!] }));
        return desc.Reservations?.[0]?.Instances?.[0]?.PublicIpAddress ?? null;
      },
      { maxAttempts: 30, delayMs: 5000 },
    );

    mergeComputeConfig(compute.name, {
      ip,
      arkd_url: `http://${ip}:${ARKD_REMOTE_PORT}`,
    });
    updateCompute(compute.name, { status: "running" });
  }

  async stop(compute: Compute): Promise<void> {
    const cfg = compute.config as RemoteConfig;
    if (!cfg.instance_id) throw new Error("No instance_id - cannot stop");

    const { EC2Client, StopInstancesCommand } = await import("@aws-sdk/client-ec2");
    const { fromIni } = await import("@aws-sdk/credential-providers");
    const { updateCompute } = await import("../../core/store.js");

    const ec2 = new EC2Client({
      region: cfg.region ?? "us-east-1",
      ...(cfg.aws_profile ? { credentials: fromIni({ profile: cfg.aws_profile }) } : {}),
    });

    await ec2.send(new StopInstancesCommand({ InstanceIds: [cfg.instance_id] }));
    updateCompute(compute.name, { status: "stopped" });
  }

  async attach(_compute: Compute, _session: Session): Promise<void> {
    // Attach handled by CLI with SSH + tmux
  }

  async syncEnvironment(compute: Compute, opts: SyncOpts): Promise<void> {
    const cfg = compute.config as RemoteConfig;
    if (!cfg.ip) return;
    const { sshKeyPath } = await import("./ec2/ssh.js");
    const { syncToHost } = await import("./ec2/sync.js");
    await syncToHost(sshKeyPath(compute.name), cfg.ip, {
      categories: opts.categories,
      onLog: opts.onLog,
    });
  }

  getAttachCommand(compute: Compute, session: Session): string[] {
    const cfg = compute.config as RemoteConfig;
    if (!session.session_id || !cfg.ip) return [];
    const { sshKeyPath } = require("./ec2/ssh.js");
    return [
      "ssh", "-i", sshKeyPath(compute.name),
      "-o", "StrictHostKeyChecking=no",
      `ubuntu@${cfg.ip}`,
      `tmux attach -t ${session.session_id}`,
    ];
  }

  buildChannelConfig(sessionId: string, stage: string, channelPort: number, opts?: { conductorUrl?: string }): Record<string, unknown> {
    return {
      command: "/home/ubuntu/.ark/bin/ark",
      args: ["channel"],
      env: {
        ARK_SESSION_ID: sessionId,
        ARK_STAGE: stage,
        ARK_CHANNEL_PORT: String(channelPort),
        ARK_CONDUCTOR_URL: opts?.conductorUrl ?? "http://localhost:19100",
        ARK_ARKD_URL: `http://localhost:${ARKD_REMOTE_PORT}`,
      },
    };
  }

  buildLaunchEnv(_session: Session): Record<string, string> {
    const env: Record<string, string> = {};
    // Forward Claude auth tokens if present
    for (const key of ["CLAUDE_CODE_API_KEY", "ANTHROPIC_API_KEY"]) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    return env;
  }

  async cleanupSession(compute: Compute, session: Session): Promise<void> {
    // Remote cleanup: remove session workdir via arkd
    if (!session.workdir) return;
    try {
      const client = this.getClient(compute);
      await client.run({ command: "rm", args: ["-rf", session.workdir] });
    } catch {}
  }
}

// ── Remote Worktree Provider (was "ec2") ────────────────────────────────────

export class RemoteWorktreeProvider extends RemoteArkdBase {
  readonly name = "ec2";
  readonly isolationType = "worktree";
  readonly isolationModes: IsolationMode[] = [
    { value: "inplace", label: "Remote checkout (in-place)" },
  ];

  async launch(compute: Compute, session: Session, opts: any): Promise<string> {
    const client = this.getClient(compute);

    // Clone repo on remote if needed
    if (session.repo) {
      const repoName = session.repo.split("/").pop()?.replace(".git", "") ?? "project";
      const remoteWorkdir = `/home/ubuntu/Projects/${repoName}`;
      await client.run({ command: "git", args: ["clone", session.repo, remoteWorkdir], timeout: 120_000 });
    }

    // Upload launcher and execute
    await client.launchAgent({
      sessionName: opts.tmuxName,
      script: opts.launcherContent,
      workdir: opts.workdir,
    });
    return opts.tmuxName;
  }
}

// ── Remote Docker Provider ──────────────────────────────────────────────────

export class RemoteDockerProvider extends RemoteArkdBase {
  readonly name = "ec2-docker";
  readonly isolationType = "docker";
  readonly isolationModes: IsolationMode[] = [
    { value: "container", label: "Docker container on EC2" },
  ];

  private containerName(compute: Compute): string {
    return `ark-${compute.name}`;
  }

  async postProvision(compute: Compute, log: (msg: string) => void): Promise<void> {
    const client = this.getClient(compute);
    const cfg = compute.config as RemoteConfig;
    const image = cfg.image || "ubuntu:22.04";
    const container = this.containerName(compute);

    log(`Pulling Docker image ${image} on remote...`);
    await client.run({ command: "docker", args: ["pull", image], timeout: 300_000 });

    log("Creating Docker container...");
    await client.run({
      command: "docker",
      args: [
        "create", "--name", container, "-it",
        "-v", "/home/ubuntu/.ssh:/root/.ssh:ro",
        "-v", "/home/ubuntu/.claude:/root/.claude:ro",
        image, "bash",
      ],
    });
    await client.run({ command: "docker", args: ["start", container] });

    const { mergeComputeConfig } = await import("../../core/store.js");
    mergeComputeConfig(compute.name, { container_name: container });
    log("Remote Docker container ready.");
  }

  async launch(compute: Compute, _session: Session, opts: any): Promise<string> {
    const client = this.getClient(compute);
    const container = this.containerName(compute);

    const scriptPath = `/tmp/arkd-launcher-${opts.tmuxName}.sh`;
    await client.writeFile({ path: scriptPath, content: opts.launcherContent, mode: 0o755 });
    await client.run({ command: "docker", args: ["cp", scriptPath, `${container}:${scriptPath}`] });
    await client.launchAgent({
      sessionName: opts.tmuxName,
      script: `#!/bin/bash\ndocker exec -i ${container} bash ${scriptPath}`,
      workdir: opts.workdir,
    });
    return opts.tmuxName;
  }
}

// ── Remote Devcontainer Provider ────────────────────────────────────────────

export class RemoteDevcontainerProvider extends RemoteArkdBase {
  readonly name = "ec2-devcontainer";
  readonly isolationType = "devcontainer";
  readonly isolationModes: IsolationMode[] = [
    { value: "devcontainer", label: "Devcontainer on EC2" },
  ];

  async postProvision(compute: Compute, log: (msg: string) => void): Promise<void> {
    const client = this.getClient(compute);
    const cfg = compute.config as RemoteConfig;
    const workdir = cfg.devcontainer_workdir || "/home/ubuntu/Projects/workspace";

    // Clone repo if configured
    if (cfg.devcontainer_workdir) {
      log("Building devcontainer on remote...");
      await client.run({
        command: "devcontainer",
        args: ["up", "--workspace-folder", workdir],
        timeout: 300_000,
      });
    }

    const { mergeComputeConfig } = await import("../../core/store.js");
    mergeComputeConfig(compute.name, { devcontainer_workdir: workdir });
    log("Remote devcontainer ready.");
  }

  async launch(compute: Compute, _session: Session, opts: any): Promise<string> {
    const client = this.getClient(compute);
    const cfg = compute.config as RemoteConfig;
    const workdir = (cfg.devcontainer_workdir as string) || opts.workdir;

    const scriptPath = `/tmp/arkd-launcher-${opts.tmuxName}.sh`;
    await client.writeFile({ path: scriptPath, content: opts.launcherContent, mode: 0o755 });
    await client.launchAgent({
      sessionName: opts.tmuxName,
      script: `#!/bin/bash\ndevcontainer exec --workspace-folder '${workdir}' -- bash ${scriptPath}`,
      workdir: opts.workdir,
    });
    return opts.tmuxName;
  }
}

// ── Remote Firecracker Provider ─────────────────────────────────────────────

export class RemoteFirecrackerProvider extends RemoteArkdBase {
  readonly name = "ec2-firecracker";
  readonly isolationType = "firecracker";
  readonly isolationModes: IsolationMode[] = [
    { value: "microvm", label: "Firecracker microVM on EC2" },
  ];

  async postProvision(compute: Compute, log: (msg: string) => void): Promise<void> {
    const client = this.getClient(compute);

    log("Installing Firecracker on remote...");
    // Download firecracker binary
    await client.run({
      command: "bash",
      args: ["-c", `
        ARCH=$(uname -m)
        RELEASE_URL="https://github.com/firecracker-microvm/firecracker/releases"
        LATEST=$(curl -fsSLI -o /dev/null -w %{url_effective} \${RELEASE_URL}/latest | grep -oE "[^/]+$")
        curl -L \${RELEASE_URL}/download/\${LATEST}/firecracker-\${LATEST}-\${ARCH}.tgz | tar -xz -C /tmp
        sudo mv /tmp/release-*/firecracker-\${LATEST}-\${ARCH} /usr/local/bin/firecracker
        sudo chmod +x /usr/local/bin/firecracker
      `],
      timeout: 120_000,
    });

    // Download a minimal kernel + rootfs (Ubuntu-based with bun)
    log("Downloading kernel and rootfs...");
    await client.run({
      command: "bash",
      args: ["-c", `
        sudo mkdir -p /opt/firecracker
        # Download pre-built kernel
        curl -fsSL -o /opt/firecracker/vmlinux \
          https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/kernels/vmlinux.bin 2>/dev/null || true
      `],
      timeout: 120_000,
    });

    const { mergeComputeConfig } = await import("../../core/store.js");
    mergeComputeConfig(compute.name, {
      firecracker_installed: true,
      kernel_path: "/opt/firecracker/vmlinux",
    });
    log("Firecracker ready on remote.");
  }

  async launch(compute: Compute, _session: Session, opts: any): Promise<string> {
    const client = this.getClient(compute);
    const cfg = compute.config as RemoteConfig;
    const vmSshPort = 2222; // Default firecracker VM SSH port

    const scriptPath = `/tmp/arkd-launcher-${opts.tmuxName}.sh`;
    await client.writeFile({ path: scriptPath, content: opts.launcherContent, mode: 0o755 });

    await client.launchAgent({
      sessionName: opts.tmuxName,
      script: [
        "#!/bin/bash",
        `scp -o StrictHostKeyChecking=no -P ${vmSshPort} ${scriptPath} root@localhost:${scriptPath}`,
        `ssh -o StrictHostKeyChecking=no -p ${vmSshPort} root@localhost bash ${scriptPath}`,
      ].join("\n"),
      workdir: opts.workdir,
    });
    return opts.tmuxName;
  }
}

// ── Cloud-init with arkd ────────────────────────────────────────────────────

function buildUserDataWithArkd(opts: { idleMinutes?: number; isolation?: string; conductorUrl?: string }): string {
  const { buildUserData } = require("./ec2/cloud-init.js");
  let base = buildUserData(opts) as string;

  const conductorFlag = opts.conductorUrl ? ` --conductor-url ${opts.conductorUrl}` : "";

  // Insert arkd startup before the ready marker
  const arkdSetup = `
# ── ArkD daemon (universal agent API) ──────────────────────────────────────
cat > /etc/systemd/system/arkd.service <<UNIT
[Unit]
Description=ArkD Agent Daemon
After=network.target

[Service]
User=ubuntu
ExecStart=/home/ubuntu/.bun/bin/bun /home/ubuntu/.ark/bin/ark arkd --port ${ARKD_REMOTE_PORT}${conductorFlag}
Restart=always
RestartSec=5
Environment=HOME=/home/ubuntu

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable arkd
systemctl start arkd

# ── Open arkd port in iptables ─────────────────────────────────────────────
iptables -A INPUT -p tcp --dport ${ARKD_REMOTE_PORT} -j ACCEPT || true
`;

  // Insert before the ready marker
  base = base.replace(
    '# ── Ready marker',
    `${arkdSetup}\n# ── Ready marker`,
  );

  return base;
}

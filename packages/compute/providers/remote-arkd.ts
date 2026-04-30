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

import { ArkdBackedProvider } from "./arkd-backed.js";
import { safeAsync } from "../../core/safe.js";
import { sshKeyPath } from "./ec2/ssh.js";
import { EC2PlacementCtx } from "./ec2/placement-ctx.js";
import type { Compute, Session, ProvisionOpts, SyncOpts, IsolationMode, LaunchOpts } from "../types.js";
import type { PlacementCtx } from "../../core/secrets/placement-types.js";
import { DEFAULT_CONDUCTOR_URL, DEFAULT_ARKD_PORT } from "../../core/constants.js";

const ARKD_REMOTE_PORT = DEFAULT_ARKD_PORT;
const REMOTE_USER = "ubuntu";
const REMOTE_HOME = `/home/${REMOTE_USER}`;

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
  readonly singleton = false;
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

  /**
   * Build an EC2-flavoured PlacementCtx so dispatch can place typed secrets
   * on the remote instance over SSH. We resolve the SSH private key from the
   * provider-managed location (`~/.ssh/ark-<computeName>`, written at
   * provision time) and the public IP from the compute config row. If either
   * is missing we throw -- placement is fail-fast on the EC2 path, and a
   * silent skip would surprise operators who declared file-typed secrets on
   * a remote stage.
   */
  async buildPlacementCtx(_session: Session, compute: Compute): Promise<PlacementCtx> {
    const cfg = compute.config as RemoteConfig;
    if (!cfg.ip) {
      throw new Error(`Compute '${compute.name}' has no IP -- cannot build EC2 PlacementCtx`);
    }
    return new EC2PlacementCtx({ sshKeyPath: sshKeyPath(compute.name), ip: cfg.ip });
  }

  async provision(compute: Compute, opts?: ProvisionOpts): Promise<void> {
    const log = opts?.onLog ?? (() => {});
    const cfg = compute.config as RemoteConfig;
    this.app.computes.update(compute.name, { status: "provisioning" });

    try {
      const { ensurePulumi, provisionStack, resolveInstanceType } = await import("./ec2/provision.js");
      const { generateSshKey } = await import("./ec2/ssh.js");
      const { hourlyRate } = await import("./ec2/cost.js");
      const { poll } = await import("../util.js");

      await ensurePulumi(log);

      log("Generating SSH key pair...");
      const { privateKeyPath } = await generateSshKey(compute.name);

      log("Building cloud-init script with arkd...");
      const conductorUrl = DEFAULT_CONDUCTOR_URL;
      const userData = await buildUserDataWithArkd({
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
      this.app.computes.update(compute.name, { status: "running" });
      this.app.computes.mergeConfig(compute.name, {
        ...(result as unknown as Record<string, unknown>),
        arkd_url: `http://${result.ip}:${ARKD_REMOTE_PORT}`,
      });

      // Store hourly rate
      const instanceType = resolveInstanceType(opts?.size ?? cfg.size ?? "m", opts?.arch ?? cfg.arch ?? "x64");
      const rate = hourlyRate(instanceType);
      if (rate > 0) this.app.computes.mergeConfig(compute.name, { hourlyRate: rate });

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
            const res = await sshExecAsync(
              privateKeyPath,
              result.ip!,
              `test -f ${REMOTE_HOME}/.ark-ready && echo ready`,
              { timeout: 10_000 },
            );
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
            } catch {
              return false;
            }
          },
          { maxAttempts: 30, delayMs: 3000 },
        );

        log("arkd is online.");

        // Post-provision isolation setup
        await this.postProvision(compute, log);
      }

      this.app.computes.mergeConfig(compute.name, { cloud_init_done: true });
    } catch (err) {
      this.app.computes.mergeConfig(compute.name, { last_error: err instanceof Error ? err.message : String(err) });
      this.app.computes.update(compute.name, { status: "stopped" });
      throw err;
    }
  }

  /** Override in subclasses for isolation-specific post-provision setup. */
  async postProvision(_compute: Compute, _log: (msg: string) => void): Promise<void> {}

  async destroy(compute: Compute): Promise<void> {
    const { destroyStack } = await import("./ec2/provision.js");
    const { destroyPool } = await import("./ec2/pool.js");
    const { teardownReverseTunnel } = await import("./ec2/ports.js");

    // Tear down the reverse tunnel set up in prepareRemoteEnvironment so
    // the SSH tunnel process doesn't outlive the EC2 instance it points at.
    const cfg = compute.config as RemoteConfig;
    if (cfg.ip) {
      await safeAsync(`[remote] destroy: teardown reverse tunnel for ${compute.name}`, async () => {
        await teardownReverseTunnel(cfg.ip!, this.app.config.ports.conductor);
      });
    }

    // Pass the resource IDs we stashed at provision time. Without these,
    // destroyStack's three branches (TerminateInstances / DeleteSecurityGroup
    // / DeleteKeyPair) all silently no-op -- the function returns success
    // without making any AWS API calls and the instance keeps billing.
    // Reproduced earlier this session: yt-ec2 reported "Compute 'yt-ec2'
    // destroyed" but `aws ec2 describe-instances` showed `running`.
    await safeAsync(`[remote] destroy: ${compute.name}`, async () => {
      await destroyStack(compute.name, {
        region: cfg.region,
        awsProfile: cfg.aws_profile,
        instance_id: cfg.instance_id,
        sg_id: cfg.sg_id,
        key_name: cfg.key_name,
      });
      destroyPool(compute.name);
    });
    this.app.computes.update(compute.name, { status: "destroyed" });
  }

  async start(compute: Compute): Promise<void> {
    const cfg = compute.config as RemoteConfig;
    if (!cfg.instance_id) throw new Error("No instance_id - cannot start");

    const { EC2Client, StartInstancesCommand, DescribeInstancesCommand } = await import("@aws-sdk/client-ec2");
    const { fromIni } = await import("@aws-sdk/credential-providers");
    const { poll } = await import("../util.js");

    const ec2 = new EC2Client({
      region: cfg.region ?? "us-east-1",
      ...(cfg.aws_profile ? { credentials: fromIni({ profile: cfg.aws_profile }) } : {}),
    });

    await ec2.send(new StartInstancesCommand({ InstanceIds: [cfg.instance_id] }));

    // Poll for public IP
    let ip: string | null = null;
    await poll(
      async () => {
        const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [cfg.instance_id!] }));
        ip = desc.Reservations?.[0]?.Instances?.[0]?.PublicIpAddress ?? null;
        return ip !== null;
      },
      { maxAttempts: 30, delayMs: 5000 },
    );

    this.app.computes.mergeConfig(compute.name, {
      ip: ip!,
      arkd_url: `http://${ip}:${ARKD_REMOTE_PORT}`,
    });

    // Wait for arkd to be reachable before marking as running
    const arkdUrl = `http://${ip}:${ARKD_REMOTE_PORT}`;
    await poll(
      async () => {
        try {
          const res = await fetch(`${arkdUrl}/health`, { signal: AbortSignal.timeout(5000) });
          return res.ok;
        } catch {
          return false;
        }
      },
      { maxAttempts: 30, delayMs: 2000 },
    );

    this.app.computes.update(compute.name, { status: "running" });
  }

  async stop(compute: Compute): Promise<void> {
    const cfg = compute.config as RemoteConfig;
    if (!cfg.instance_id) throw new Error("No instance_id - cannot stop");

    // Tear down the reverse tunnel before the EC2 stop -- the ssh process is
    // local; killing it after the instance halts only delays cleanup.
    if (cfg.ip) {
      const { teardownReverseTunnel } = await import("./ec2/ports.js");
      await safeAsync(`[remote] stop: teardown reverse tunnel for ${compute.name}`, async () => {
        await teardownReverseTunnel(cfg.ip!, this.app.config.ports.conductor);
      });
    }

    const { EC2Client, StopInstancesCommand } = await import("@aws-sdk/client-ec2");
    const { fromIni } = await import("@aws-sdk/credential-providers");

    const ec2 = new EC2Client({
      region: cfg.region ?? "us-east-1",
      ...(cfg.aws_profile ? { credentials: fromIni({ profile: cfg.aws_profile }) } : {}),
    });

    await ec2.send(new StopInstancesCommand({ InstanceIds: [cfg.instance_id] }));
    this.app.computes.update(compute.name, { status: "stopped" });
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
      direction: opts.direction,
      categories: opts.categories,
      onLog: opts.onLog,
    });
  }

  getAttachCommand(compute: Compute, session: Session): string[] {
    const cfg = compute.config as RemoteConfig;
    if (!session.session_id || !cfg.ip) return [];
    return [
      "ssh",
      "-i",
      sshKeyPath(compute.name),
      "-o",
      "StrictHostKeyChecking=no",
      `${REMOTE_USER}@${cfg.ip}`,
      `tmux attach -t ${session.session_id}`,
    ];
  }

  buildChannelConfig(
    sessionId: string,
    stage: string,
    channelPort: number,
    opts?: { conductorUrl?: string },
  ): Record<string, unknown> {
    return {
      command: `${REMOTE_HOME}/.ark/bin/ark`,
      args: ["channel"],
      env: {
        ARK_SESSION_ID: sessionId,
        ARK_STAGE: stage,
        ARK_CHANNEL_PORT: String(channelPort),
        ARK_CONDUCTOR_URL: opts?.conductorUrl ?? DEFAULT_CONDUCTOR_URL,
        ARK_ARKD_URL: `http://localhost:${ARKD_REMOTE_PORT}`, // always localhost on the remote host
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
    if (!session.workdir) return;
    const client = this.getClient(compute);
    await safeAsync(`[remote] cleanupSession: rm workdir for ${session.id} on ${compute.name}`, async () => {
      await client.run({ command: "rm", args: ["-rf", session.workdir!] });
    });
  }
}

// ── Remote Worktree Provider (was "ec2") ────────────────────────────────────

export class RemoteWorktreeProvider extends RemoteArkdBase {
  readonly name = "ec2";
  readonly isolationType = "worktree";
  readonly isolationModes: IsolationMode[] = [{ value: "inplace", label: "Remote checkout (in-place)" }];

  /**
   * Pick the URL/path EC2 should clone from. `session.repo` is the local-
   * filesystem path on the conductor (e.g. /Users/yana/Projects/ark) which
   * doesn't exist on EC2; `session.config.remoteRepo` is the URL the user
   * passed via `--remote-repo` and is the source of truth for remote clones.
   * Prefer the remote URL; fall back to session.repo only when the conductor
   * and the compute target share a filesystem (not the case for EC2 today,
   * but keeps the contract honest for future co-located compute kinds).
   */
  private cloneSource(session: Session): string | null {
    const cfg = session.config as { remoteRepo?: string } | null | undefined;
    if (cfg?.remoteRepo) return cfg.remoteRepo;
    if (session.repo) return session.repo;
    return null;
  }

  /** Repo basename used to derive the workdir path under ${REMOTE_HOME}/Projects. */
  private repoBasename(session: Session): string {
    const src = this.cloneSource(session);
    if (!src) return "project";
    return (
      src
        .split("/")
        .pop()
        ?.replace(/\.git$/, "") ?? "project"
    );
  }

  /**
   * Where the cloned worktree lives on the remote host. The executor reads
   * this via the optional `provider.resolveWorkdir(...)` hook to (a) embed
   * the right path in the launcher's `cd` and (b) target the right path in
   * the heredocs that write `.mcp.json` / `.claude/settings.local.json` on
   * the remote. Without this, the launcher gets the conductor's local
   * workdir which doesn't exist on Ubuntu.
   */
  resolveWorkdir(_compute: Compute, session: Session): string | null {
    if (!this.cloneSource(session)) return null;
    return `${REMOTE_HOME}/Projects/${this.repoBasename(session)}`;
  }

  async launch(compute: Compute, session: Session, opts: LaunchOpts): Promise<string> {
    const client = this.getClient(compute);

    // Clone repo on remote if a source URL/path is set. We MUST use the
    // remote-reachable URL (session.config.remoteRepo) when present --
    // session.repo is the conductor-local path, which doesn't exist on EC2.
    // The previous \`git clone <session.repo> ...\` invocation silently
    // failed (path not found on remote), leaving an empty workdir and
    // making the agent run against nothing.
    const remoteWorkdir = this.resolveWorkdir(compute, session);
    const source = this.cloneSource(session);
    if (source && remoteWorkdir) {
      await client.run({ command: "git", args: ["clone", source, remoteWorkdir], timeout: 120_000 });
    }

    // Upload launcher and execute. tmux's `-c <workdir>` flag wants the same
    // path the launcher will `cd` into, otherwise we'd race against the
    // launcher's own cd (and on a remote host the conductor-side path
    // doesn't exist as a directory anyway).
    await client.launchAgent({
      sessionName: opts.tmuxName,
      script: opts.launcherContent,
      workdir: remoteWorkdir ?? opts.workdir,
    });
    return opts.tmuxName;
  }
}

// ── Remote Docker Provider ──────────────────────────────────────────────────
//
// Will be superseded by `EC2Compute + DockerRuntime`. Today's sessions still
// dispatch through these classes for killAgent / cleanupSession / metrics --
// the new Compute interface doesn't cover those verbs yet, so the classes
// below stay registered at boot and remain the live path.

export class RemoteDockerProvider extends RemoteArkdBase {
  readonly name = "ec2-docker";
  readonly isolationType = "docker";
  readonly isolationModes: IsolationMode[] = [{ value: "container", label: "Docker container on EC2" }];

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
        "create",
        "--name",
        container,
        "-it",
        "-v",
        `${REMOTE_HOME}/.ssh:/root/.ssh:ro`,
        "-v",
        `${REMOTE_HOME}/.claude:/root/.claude:ro`,
        image,
        "bash",
      ],
    });
    await client.run({ command: "docker", args: ["start", container] });

    this.app.computes.mergeConfig(compute.name, { container_name: container });
    log("Remote Docker container ready.");
  }

  async launch(compute: Compute, _session: Session, opts: LaunchOpts): Promise<string> {
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
  readonly isolationModes: IsolationMode[] = [{ value: "devcontainer", label: "Devcontainer on EC2" }];

  async postProvision(compute: Compute, log: (msg: string) => void): Promise<void> {
    const client = this.getClient(compute);
    const cfg = compute.config as RemoteConfig;
    const workdir = cfg.devcontainer_workdir || `${REMOTE_HOME}/Projects/workspace`;

    // Clone repo if configured
    if (cfg.devcontainer_workdir) {
      log("Building devcontainer on remote...");
      await client.run({
        command: "devcontainer",
        args: ["up", "--workspace-folder", workdir],
        timeout: 300_000,
      });
    }

    this.app.computes.mergeConfig(compute.name, { devcontainer_workdir: workdir });
    log("Remote devcontainer ready.");
  }

  async launch(compute: Compute, _session: Session, opts: LaunchOpts): Promise<string> {
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
  readonly isolationModes: IsolationMode[] = [{ value: "microvm", label: "Firecracker microVM on EC2" }];

  async postProvision(compute: Compute, log: (msg: string) => void): Promise<void> {
    const client = this.getClient(compute);

    log("Installing Firecracker on remote...");
    // Download firecracker binary
    await client.run({
      command: "bash",
      args: [
        "-c",
        `
        ARCH=$(uname -m)
        RELEASE_URL="https://github.com/firecracker-microvm/firecracker/releases"
        LATEST=$(curl -fsSLI -o /dev/null -w %{url_effective} \${RELEASE_URL}/latest | grep -oE "[^/]+$")
        curl -L \${RELEASE_URL}/download/\${LATEST}/firecracker-\${LATEST}-\${ARCH}.tgz | tar -xz -C /tmp
        sudo mv /tmp/release-*/firecracker-\${LATEST}-\${ARCH} /usr/local/bin/firecracker
        sudo chmod +x /usr/local/bin/firecracker
      `,
      ],
      timeout: 120_000,
    });

    // Download a minimal kernel + rootfs (Ubuntu-based with bun)
    log("Downloading kernel and rootfs...");
    await client.run({
      command: "bash",
      args: [
        "-c",
        `
        sudo mkdir -p /opt/firecracker
        # Download pre-built kernel
        curl -fsSL -o /opt/firecracker/vmlinux \
          https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/kernels/vmlinux.bin 2>/dev/null || true
      `,
      ],
      timeout: 120_000,
    });

    this.app.computes.mergeConfig(compute.name, {
      firecracker_installed: true,
      kernel_path: "/opt/firecracker/vmlinux",
    });
    log("Firecracker ready on remote.");
  }

  async launch(compute: Compute, _session: Session, opts: LaunchOpts): Promise<string> {
    const client = this.getClient(compute);
    const _cfg = compute.config as RemoteConfig;
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

async function buildUserDataWithArkd(opts: {
  idleMinutes?: number;
  isolation?: string;
  conductorUrl?: string;
}): Promise<string> {
  const { buildUserData } = await import("./ec2/cloud-init.js");
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
# install.sh (https://ytarasova.github.io/ark/install.sh) drops a Bun-compiled
# ELF at ~/.ark/bin/ark -- run it directly. The previous \`bun \${ark}\` prefix
# made bun parse the ELF as JS source and crash at :1:1, leaving systemd
# in an "activating (auto-restart)" loop and the post-provision arkd-health
# poll failing.
ExecStart=${REMOTE_HOME}/.ark/bin/ark arkd --port ${ARKD_REMOTE_PORT}${conductorFlag}
Restart=always
RestartSec=5
Environment=HOME=${REMOTE_HOME}

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
  base = base.replace("# ── Ready marker", `${arkdSetup}\n# ── Ready marker`);

  return base;
}

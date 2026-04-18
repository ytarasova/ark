/**
 * Local compute providers - all 4 isolation modes running on localhost.
 *
 * Each extends ArkdBackedProvider and talks to arkd on localhost:19300.
 * Isolation is handled by how the launcher script is structured:
 *   - worktree: direct execution
 *   - docker: docker exec wrapper
 *   - devcontainer: devcontainer exec wrapper
 *   - firecracker: SSH into microVM wrapper
 */

import { existsSync, rmSync } from "fs";
import { join } from "path";

import { ArkdBackedProvider } from "./arkd-backed.js";
import { safeAsync } from "../../core/safe.js";
import {
  pullImage,
  createContainer,
  startContainer,
  stopContainer,
  removeContainer,
  bootstrapContainer,
  startArkdInContainer,
  waitForArkdHealth,
  resolveArkSourceRoot,
  DEFAULT_IMAGE,
  type BootstrapOpts,
} from "./docker/helpers.js";
import { allocatePort } from "../../core/config/port-allocator.js";
import type { Compute, Session, ProvisionOpts, SyncOpts, IsolationMode, LaunchOpts } from "../types.js";
import { DEFAULT_ARKD_URL, DEFAULT_CONDUCTOR_URL } from "../../core/constants.js";
import { channelLaunchSpec } from "../../core/install-paths.js";

// ── Shared local base ───────────────────────────────────────────────────────

abstract class LocalArkdBase extends ArkdBackedProvider {
  readonly canReboot = false;
  readonly needsAuth = false;

  getArkdUrl(_compute: Compute): string {
    return DEFAULT_ARKD_URL;
  }

  async attach(_compute: Compute, _session: Session): Promise<void> {
    // Local: tmux attach handled by CLI layer, no tunnels
  }

  async syncEnvironment(_compute: Compute, _opts: SyncOpts): Promise<void> {
    // Local: shared filesystem, no sync needed
  }

  getAttachCommand(_compute: Compute, session: Session): string[] {
    if (!session.session_id) return [];
    return ["tmux", "attach", "-t", session.session_id];
  }

  buildChannelConfig(
    sessionId: string,
    stage: string,
    channelPort: number,
    opts?: { conductorUrl?: string },
  ): Record<string, unknown> {
    // channelLaunchSpec() self-spawns in compiled mode, uses bun+source in dev.
    const spec = channelLaunchSpec();
    return {
      command: spec.command,
      args: spec.args,
      env: {
        ARK_SESSION_ID: sessionId,
        ARK_STAGE: stage,
        ARK_CHANNEL_PORT: String(channelPort),
        ARK_CONDUCTOR_URL: opts?.conductorUrl ?? DEFAULT_CONDUCTOR_URL,
        ARK_ARKD_URL: DEFAULT_ARKD_URL,
      },
    };
  }

  buildLaunchEnv(_session: Session): Record<string, string> {
    return {};
  }
}

// ── Local Worktree Provider ─────────────────────────────────────────────────

export class LocalWorktreeProvider extends LocalArkdBase {
  readonly name = "local";
  readonly isolationModes: IsolationMode[] = [
    { value: "worktree", label: "Git worktree (isolated)" },
    { value: "inplace", label: "In-place (direct)" },
  ];
  readonly canDelete = false;
  readonly supportsWorktree = true;
  readonly initialStatus = "running";

  async provision(_compute: Compute, _opts?: ProvisionOpts): Promise<void> {
    // Local machine is always provisioned
  }

  async destroy(_compute: Compute): Promise<void> {
    throw new Error("Cannot destroy the local compute");
  }

  async start(_compute: Compute): Promise<void> {
    // Always running
  }

  async stop(_compute: Compute): Promise<void> {
    throw new Error("Cannot stop the local compute");
  }

  async cleanupSession(_compute: Compute, session: Session): Promise<void> {
    const wtPath = join(this.app.config.worktreesDir, session.id);
    if (!existsSync(wtPath)) return;

    const repo = session.workdir ?? session.repo;
    if (repo) {
      const { spawn } = await import("child_process");
      const ok = await new Promise<boolean>((resolve) => {
        const cp = spawn("git", ["-C", repo!, "worktree", "remove", "--force", wtPath], { stdio: "pipe" });
        cp.on("close", (code: number | null) => resolve(code === 0));
        cp.on("error", () => resolve(false));
      });
      if (ok) return;
    }
    // Fallback: direct rmSync
    await safeAsync(`[local] cleanupSession: rmSync worktree for ${session.id}`, async () => {
      rmSync(wtPath, { recursive: true, force: true });
    });
  }
}

// ── Local Docker Provider (arkd sidecar) ────────────────────────────────────

/**
 * Docker compute target that runs arkd as a sidecar inside the container.
 *
 * Architecture:
 *   - Container is created with a loopback port mapping 127.0.0.1:H -> :19300.
 *   - Bootstrap installs bun + tmux + claude (idempotent; skipped on images
 *     that already have them via `config.bootstrap: { skip: true }`).
 *   - arkd is started INSIDE the container bound to 0.0.0.0:19300.
 *   - Host conductor talks to arkd at http://localhost:H. No docker exec
 *     wrappers, no host->container path parity tricks: arkd resolves paths
 *     against the container's own filesystem.
 *
 * Mounts (see createContainer):
 *   - /opt/ark   <- host ark repo (ro)      arkd source for `bun run`
 *   - arkDir     <- host arkDir  (rw)       tracks, launchers, recordings
 *   - workdir    <- host workdir (rw)       session workspace at same path
 *   - ~/.claude  <- ~/.claude (ro)          agent credentials
 *   - ~/.ssh     <- ~/.ssh    (ro)          git push over SSH
 */
export class LocalDockerProvider extends LocalArkdBase {
  readonly name = "docker";
  readonly isolationModes: IsolationMode[] = [{ value: "container", label: "Docker container (arkd sidecar)" }];
  readonly canDelete = true;
  readonly supportsWorktree = false;
  readonly initialStatus = "stopped";

  private containerName(compute: Compute): string {
    return `ark-${compute.name}`;
  }

  /**
   * Per-compute arkd URL. Stored on the compute config during provision so
   * restarts reuse the same port. Falls back to the legacy DEFAULT_ARKD_URL
   * only if no port was persisted (legacy compute records from pre-sidecar).
   */
  override getArkdUrl(compute: Compute): string {
    const cfg = compute.config as Record<string, unknown>;
    const hostPort = cfg.arkd_host_port as number | undefined;
    if (typeof hostPort === "number") return `http://localhost:${hostPort}`;
    return DEFAULT_ARKD_URL;
  }

  async provision(compute: Compute, _opts?: ProvisionOpts): Promise<void> {
    const cfg = compute.config as Record<string, unknown>;
    const name = this.containerName(compute);
    const image = (cfg.image as string) || DEFAULT_IMAGE;
    const extraVolumes = (cfg.volumes as string[]) ?? [];
    const bootstrapOpts = (cfg.bootstrap as BootstrapOpts) ?? {};
    const workdir = (cfg.workdir as string) || undefined;

    const arkSource = resolveArkSourceRoot();
    if (!arkSource) {
      throw new Error(
        "Cannot locate ark source tree on host. The arkd-sidecar Docker provider needs the repo root mounted " +
          "into the container at /opt/ark. Run from a source checkout or set ARK_SOURCE_ROOT.",
      );
    }

    this.app.computes.update(compute.name, { status: "provisioning" });

    try {
      const arkdHostPort = await allocatePort();
      const arkdUrl = `http://localhost:${arkdHostPort}`;

      await pullImage(image);
      await createContainer(name, image, {
        extraVolumes,
        arkDir: this.app.config.dirs.ark,
        arkSource,
        workdir,
        arkdHostPort,
      });
      await startContainer(name);

      // Bootstrap is idempotent; users with a pre-built image can set
      // `bootstrap: { skip: true }` to short-circuit.
      await bootstrapContainer(name, bootstrapOpts);

      // Launch arkd inside the container, then wait for the host-side port
      // mapping to respond. The conductor URL we pass is the host's conductor
      // as seen from the container -- docker's default bridge exposes the
      // host via host.docker.internal (macOS/Windows) or the gateway IP
      // (Linux). We use host.docker.internal which Docker Desktop provides
      // on macOS/Windows; on Linux we rely on --add-host support or a
      // fallback loopback route. For now we pass the raw URL; sessions that
      // do not need conductor callbacks (most) will not hit this path.
      const conductorUrl = `http://host.docker.internal:${this.app.config.ports.conductor}`;
      await startArkdInContainer(name, conductorUrl);
      await waitForArkdHealth(arkdUrl, 30_000);

      this.app.computes.mergeConfig(compute.name, {
        image,
        container_name: name,
        arkd_host_port: arkdHostPort,
        arkd_url: arkdUrl,
        ark_source_host: arkSource,
      });
      this.app.computes.update(compute.name, { status: "running" });
    } catch (err) {
      this.app.computes.mergeConfig(compute.name, { last_error: err instanceof Error ? err.message : String(err) });
      this.app.computes.update(compute.name, { status: "stopped" });
      throw err;
    }
  }

  async destroy(compute: Compute): Promise<void> {
    const name = this.containerName(compute);
    await safeAsync(`[docker] destroy: rm container ${name}`, async () => {
      await removeContainer(name);
    });
    this.app.computes.update(compute.name, { status: "destroyed" });
  }

  async start(compute: Compute): Promise<void> {
    const cfg = compute.config as Record<string, unknown>;
    const name = this.containerName(compute);
    await startContainer(name);

    // docker start preserves the -p port mapping set at create time, but
    // arkd inside the container is NOT started automatically on restart.
    // Re-launch it and wait for health.
    const arkdUrl = this.getArkdUrl(compute);
    const conductorUrl =
      (cfg.conductor_url as string) || `http://host.docker.internal:${this.app.config.ports.conductor}`;
    await startArkdInContainer(name, conductorUrl);
    await waitForArkdHealth(arkdUrl, 30_000);

    this.app.computes.update(compute.name, { status: "running" });
  }

  async stop(compute: Compute): Promise<void> {
    const name = this.containerName(compute);
    await safeAsync(`[docker] stop: container ${name}`, async () => {
      await stopContainer(name);
    });
    this.app.computes.update(compute.name, { status: "stopped" });
  }

  async cleanupSession(_compute: Compute, _session: Session): Promise<void> {
    // Sidecar model: nothing to clean up at the container level when a session
    // ends. arkd inside the container already tore down the tmux session via
    // killAgent. The container keeps running to serve the next session.
  }

  /**
   * ArkdBackedProvider.launch already does the right thing -- it calls
   * arkd.launchAgent, which runs inside the container. No docker cp / docker
   * exec needed. We inherit that default.
   */
}

// ── Local Devcontainer Provider ─────────────────────────────────────────────

export class LocalDevcontainerProvider extends LocalArkdBase {
  readonly name = "devcontainer";
  readonly isolationModes: IsolationMode[] = [{ value: "devcontainer", label: "Devcontainer (project-defined)" }];
  readonly canDelete = true;
  readonly supportsWorktree = false;
  readonly initialStatus = "stopped";

  async provision(compute: Compute, _opts?: ProvisionOpts): Promise<void> {
    const cfg = compute.config as Record<string, unknown>;
    const workdir = (cfg.workdir as string) || process.cwd();

    const { detectDevcontainer, buildDevcontainer } = await import("./docker/devcontainer.js");
    if (!detectDevcontainer(workdir)) {
      throw new Error(`No devcontainer.json found in ${workdir}`);
    }

    this.app.computes.update(compute.name, { status: "provisioning" });

    const result = await buildDevcontainer(workdir);
    if (!result.ok) throw new Error(`devcontainer up failed: ${result.error}`);

    this.app.computes.mergeConfig(compute.name, { devcontainer: true, workdir });
    this.app.computes.update(compute.name, { status: "running" });
  }

  async destroy(compute: Compute): Promise<void> {
    // devcontainer doesn't have a clean "destroy" - stop is enough
    this.app.computes.update(compute.name, { status: "destroyed" });
  }

  async start(compute: Compute): Promise<void> {
    const cfg = compute.config as Record<string, unknown>;
    const workdir = (cfg.workdir as string) || process.cwd();
    const { buildDevcontainer } = await import("./docker/devcontainer.js");
    await buildDevcontainer(workdir);
    this.app.computes.update(compute.name, { status: "running" });
  }

  async stop(compute: Compute): Promise<void> {
    this.app.computes.update(compute.name, { status: "stopped" });
  }

  async cleanupSession(_compute: Compute, _session: Session): Promise<void> {
    // Devcontainer stays running; session cleanup is a noop
  }

  async launch(compute: Compute, _session: Session, opts: LaunchOpts): Promise<string> {
    const client = this.getClient(compute);
    const cfg = compute.config as Record<string, unknown>;
    const workdir = (cfg.workdir as string) || opts.workdir;

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

// ── Local Firecracker Provider ──────────────────────────────────────────────

export class LocalFirecrackerProvider extends LocalArkdBase {
  readonly name = "firecracker";
  readonly isolationModes: IsolationMode[] = [{ value: "microvm", label: "Firecracker microVM (hardware isolation)" }];
  readonly canDelete = true;
  readonly supportsWorktree = false;
  readonly initialStatus = "stopped";

  async provision(compute: Compute, _opts?: ProvisionOpts): Promise<void> {
    const { platform } = await import("os");
    if (platform() !== "linux") {
      throw new Error("Firecracker requires Linux with /dev/kvm. Use ec2-firecracker for remote.");
    }
    if (!existsSync("/dev/kvm")) {
      throw new Error(
        "Firecracker requires /dev/kvm (KVM support). Enable nested virtualization or use a bare-metal host.",
      );
    }

    const cfg = compute.config as Record<string, unknown>;
    this.app.computes.update(compute.name, { status: "provisioning" });

    // Firecracker provisioning:
    // 1. Download kernel + rootfs if not present
    // 2. Create VM config
    // 3. Start firecracker process
    const vmId = `ark-fc-${compute.name}`;
    const kernelPath = (cfg.kernel as string) || "/opt/firecracker/vmlinux";
    const rootfsPath = (cfg.rootfs as string) || "/opt/firecracker/rootfs.ext4";

    if (!existsSync(kernelPath)) {
      throw new Error(
        `Firecracker kernel not found at ${kernelPath}. Download from https://github.com/firecracker-microvm/firecracker/releases`,
      );
    }
    if (!existsSync(rootfsPath)) {
      throw new Error(`Firecracker rootfs not found at ${rootfsPath}. Build one with bun + tmux installed.`);
    }

    const client = this.getClient(compute);
    const socketPath = `/tmp/firecracker-${vmId}.sock`;

    // Start firecracker process
    await client.run({
      command: "firecracker",
      args: ["--api-sock", socketPath],
      timeout: 10_000,
    });

    // Configure VM via API
    const vmConfig = JSON.stringify({
      boot_source: { kernel_image_path: kernelPath, boot_args: "console=ttyS0 reboot=k panic=1 pci=off" },
      drives: [{ drive_id: "rootfs", path_on_host: rootfsPath, is_root_device: true, is_read_only: false }],
      machine_config: { vcpu_count: (cfg.vcpus as number) || 2, mem_size_mib: (cfg.memMib as number) || 512 },
    });

    await client.run({
      command: "curl",
      args: [
        "--unix-socket",
        socketPath,
        "-X",
        "PUT",
        "http://localhost/machine-config",
        "-H",
        "Content-Type: application/json",
        "-d",
        vmConfig,
      ],
    });

    // Start the VM
    await client.run({
      command: "curl",
      args: [
        "--unix-socket",
        socketPath,
        "-X",
        "PUT",
        "http://localhost/actions",
        "-H",
        "Content-Type: application/json",
        "-d",
        '{"action_type":"InstanceStart"}',
      ],
    });

    this.app.computes.mergeConfig(compute.name, {
      vm_id: vmId,
      socket_path: socketPath,
      kernel: kernelPath,
      rootfs: rootfsPath,
    });
    this.app.computes.update(compute.name, { status: "running" });
  }

  async destroy(compute: Compute): Promise<void> {
    const cfg = compute.config as Record<string, unknown>;
    const socketPath = cfg.socket_path as string;
    if (socketPath) {
      const client = this.getClient(compute);
      await client.run({
        command: "curl",
        args: [
          "--unix-socket",
          socketPath,
          "-X",
          "PUT",
          "http://localhost/actions",
          "-H",
          "Content-Type: application/json",
          "-d",
          '{"action_type":"SendCtrlAltDel"}',
        ],
      });
    }
    this.app.computes.update(compute.name, { status: "destroyed" });
  }

  async start(compute: Compute): Promise<void> {
    // Firecracker VMs can't be paused/resumed - need full re-provision
    await this.provision(compute);
  }

  async stop(compute: Compute): Promise<void> {
    await this.destroy(compute);
    this.app.computes.update(compute.name, { status: "stopped" });
  }

  async cleanupSession(_compute: Compute, _session: Session): Promise<void> {
    // VM stays running; session cleanup is a noop
  }

  async launch(compute: Compute, _session: Session, opts: LaunchOpts): Promise<string> {
    const client = this.getClient(compute);
    const cfg = compute.config as Record<string, unknown>;
    const vmSshPort = (cfg.ssh_port as number) || 2222;

    const scriptPath = `/tmp/arkd-launcher-${opts.tmuxName}.sh`;
    await client.writeFile({ path: scriptPath, content: opts.launcherContent, mode: 0o755 });

    // Copy script into VM via SSH, then exec
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

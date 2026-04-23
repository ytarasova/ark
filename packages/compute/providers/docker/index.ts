/**
 * Docker compute provider -- runs sessions in local Docker containers.
 * No SSH or remote host needed; everything is local but containerized.
 *
 * Container lifecycle:
 *   provision → pull/build image, docker create, docker start
 *   launch    → docker exec wrapped in a tmux session
 *   stop      → docker stop
 *   start     → docker start
 *   destroy   → docker rm -f
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
import type {
  ComputeProvider,
  ProvisionOpts,
  LaunchOpts,
  SyncOpts,
  ComputeSnapshot,
  ComputeMetrics,
  ComputeProcess,
  PortDecl,
  PortStatus,
} from "../../types.js";
import type { Compute, Session } from "../../../types/index.js";
import type { AppContext } from "../../../core/app.js";
import { tmuxBin } from "../../../core/infra/tmux.js";
import { buildDevcontainer, detectDevcontainer } from "./devcontainer.js";
import {
  pullImage,
  createContainer,
  startContainer,
  stopContainer,
  removeContainer,
  DEFAULT_IMAGE,
} from "./helpers.js";
import { safeAsync } from "../../../core/safe.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Run a command asynchronously, return trimmed stdout or "" on failure. */
async function run(cmd: string, args: string[]): Promise<string> {
  let result = "";
  await safeAsync(`[docker] run: ${cmd} ${args[0] ?? ""}`, async () => {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: 30_000,
      encoding: "utf-8",
    });
    result = stdout.trim();
  });
  return result;
}

/** Build the container name from a host name. */
export function containerName(hostName: string): string {
  return `ark-${hostName}`;
}

// ── docker stats parsing ─────────────────────────────────────────────────────

export interface DockerStatsRow {
  name: string;
  cpu: number;
  memUsedGb: number;
  memTotalGb: number;
  memPct: number;
  cpuRaw: string; // "1.23%"
  memRaw: string; // "123.4MiB / 7.776GiB"
}

/**
 * Parse `docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"`.
 * Returns one row per non-empty line. Tolerant of malformed input (skips bad rows).
 * Exported for unit tests; single-call collapse of the former two-query pattern.
 */
export function parseDockerStats(raw: string): DockerStatsRow[] {
  const out: DockerStatsRow[] = [];
  if (!raw) return out;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const [name, cpuRaw, memRaw, memPctRaw] = parts;
    const cpu = parseFloat(cpuRaw.replace("%", "")) || 0;
    const memPct = parseFloat(memPctRaw.replace("%", "")) || 0;
    let memUsedGb = 0;
    let memTotalGb = 0;
    const memMatch = memRaw.match(/([\d.]+)\s*(MiB|GiB|KiB)\s*\/\s*([\d.]+)\s*(MiB|GiB|KiB)/);
    if (memMatch) {
      memUsedGb = toGb(parseFloat(memMatch[1]), memMatch[2]);
      memTotalGb = toGb(parseFloat(memMatch[3]), memMatch[4]);
    }
    out.push({ name: name.trim(), cpu, memUsedGb, memTotalGb, memPct, cpuRaw: cpuRaw.trim(), memRaw: memRaw.trim() });
  }
  return out;
}

/** Check if a port is listening on the local host. */
async function checkHostPort(port: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-i", `:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Check whether Docker daemon is reachable. */
async function assertDockerAvailable(): Promise<void> {
  try {
    await execFileAsync("docker", ["info"], {
      timeout: 10_000,
    });
  } catch (e: any) {
    throw new Error(`Docker is not available. Is the Docker daemon running? (${e?.message ?? e})`);
  }
}

// ── Provider ─────────────────────────────────────────────────────────────────

/**
 * @deprecated Superseded by `LocalCompute + DockerRuntime` (Wave 2).
 *
 * This class implements the legacy "host tmux + docker exec" model and is no
 * longer registered at boot (see app.ts step 4 -- LocalDockerProvider /
 * DockerRuntime took over). Kept exported for existing tests and for
 * downstream consumers that referenced it directly. Will be removed in a
 * follow-up once those dependencies migrate.
 */
export class DockerProvider implements ComputeProvider {
  readonly name = "docker";
  readonly isolationModes = [{ value: "container", label: "Docker container (isolated)" }];
  readonly singleton = false;
  readonly canReboot = false;
  readonly canDelete = true;
  readonly supportsWorktree = false;
  readonly initialStatus = "stopped";
  readonly needsAuth = false;
  readonly supportsSecretMount = false;

  private app!: AppContext;

  setApp(app: AppContext): void {
    this.app = app;
  }

  // ── Provision ────────────────────────────────────────────────────────────

  async provision(compute: Compute, _opts?: ProvisionOpts): Promise<void> {
    await assertDockerAvailable();

    const cfg = compute.config as Record<string, unknown>;
    const name = containerName(compute.name);
    const useDevcontainer = Boolean(cfg.devcontainer);
    const image = (cfg.image as string) || DEFAULT_IMAGE;
    const extraVolumes = (cfg.volumes as string[]) ?? [];

    await this.app.computes.update(compute.name, { status: "provisioning" });

    try {
      if (useDevcontainer) {
        // Devcontainer path -- delegate to `devcontainer up`
        const workdir = (cfg.workdir as string) || process.cwd();
        if (!detectDevcontainer(workdir)) {
          throw new Error(`No devcontainer.json found in ${workdir}`);
        }
        const result = await buildDevcontainer(workdir);
        if (!result.ok) {
          throw new Error(`devcontainer up failed: ${result.error}`);
        }
        await this.app.computes.mergeConfig(compute.name, {
          container_name: name,
          devcontainer: true,
          workdir,
        });
      } else {
        // Plain Docker path -- pull image, create persistent container
        await pullImage(image);
        await createContainer(name, image, { extraVolumes });
        await startContainer(name);

        // Read back the real container ID
        const containerId = await run("docker", ["inspect", "--format", "{{.Id}}", name]);

        await this.app.computes.mergeConfig(compute.name, {
          image,
          container_id: containerId || name,
          container_name: name,
        });
      }

      await this.app.computes.update(compute.name, { status: "running" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.app.computes.mergeConfig(compute.name, { last_error: message });
      this.app.computes.update(compute.name, { status: "stopped" });
      throw err;
    }
  }

  // ── Start / Stop ─────────────────────────────────────────────────────────

  async start(compute: Compute): Promise<void> {
    const name = containerName(compute.name);
    try {
      await startContainer(name);
    } catch (err) {
      throw new Error(`Failed to start container ${name}: ${err instanceof Error ? err.message : err}`);
    }
    this.app.computes.update(compute.name, { status: "running" });
  }

  async stop(compute: Compute): Promise<void> {
    const name = containerName(compute.name);
    await safeAsync(`[docker] stop: container ${name}`, async () => {
      await stopContainer(name);
    });
    this.app.computes.update(compute.name, { status: "stopped" });
  }

  // ── Destroy ──────────────────────────────────────────────────────────────

  async destroy(compute: Compute): Promise<void> {
    const name = containerName(compute.name);
    await safeAsync(`[docker] destroy: rm container ${name}`, async () => {
      await removeContainer(name);
    });
    this.app.computes.update(compute.name, { status: "destroyed" });
  }

  // ── Launch ───────────────────────────────────────────────────────────────

  async launch(_compute: Compute, _session: Session, opts: LaunchOpts): Promise<string> {
    const { createSessionAsync, writeLauncher } = await import("../../../core/infra/tmux.js");

    const cfg = _compute.config as Record<string, unknown>;
    const name = (cfg.container_name as string) || containerName(_compute.name);
    const useDevcontainer = Boolean(cfg.devcontainer);

    let shellCmd: string;

    if (useDevcontainer) {
      const workdir = (cfg.workdir as string) || opts.workdir;
      // Write launcher locally, then exec via devcontainer
      const launcherPath = writeLauncher(opts.tmuxName, opts.launcherContent, this.app.config.dirs.tracks);
      shellCmd = `devcontainer exec --workspace-folder '${workdir}' -- bash ${launcherPath}`;
    } else {
      // Write launcher locally, then docker exec it
      const launcherPath = writeLauncher(opts.tmuxName, opts.launcherContent, this.app.config.dirs.tracks);
      shellCmd = `docker exec -it ${name} bash ${launcherPath}`;
    }

    await createSessionAsync(opts.tmuxName, shellCmd, { arkDir: this.app.config.dirs.ark });
    return opts.tmuxName;
  }

  // ── Attach ───────────────────────────────────────────────────────────────

  async attach(_compute: Compute, _session: Session): Promise<void> {
    // No tunnels needed for local Docker -- tmux attach handled by CLI layer
  }

  // ── Session lifecycle ─────────────────────────────────────────────────

  async killAgent(_compute: Compute, session: Session): Promise<void> {
    if (!session.session_id) return;
    const { killSessionAsync } = await import("../../../core/infra/tmux.js");
    await killSessionAsync(session.session_id);
  }

  async captureOutput(_compute: Compute, session: Session, opts?: { lines?: number }): Promise<string> {
    if (!session.session_id) return "";
    const { capturePaneAsync } = await import("../../../core/infra/tmux.js");
    return capturePaneAsync(session.session_id, opts);
  }

  async cleanupSession(compute: Compute, _session: Session): Promise<void> {
    const name = containerName(compute.name);
    await safeAsync(`[docker] cleanupSession: stop container ${name}`, async () => {
      await stopContainer(name);
    });
  }

  // ── Metrics ──────────────────────────────────────────────────────────────

  /**
   * Populates metrics (cpu, mem, disk, uptime), processes, and docker fields.
   * sessions is always empty (Docker containers don't have tmux sessions inside).
   * netRxMb/netTxMb and idleTicks are always 0.
   */
  async getMetrics(compute: Compute): Promise<ComputeSnapshot> {
    const name = containerName(compute.name);

    // Collapsed from the former two-call docker-stats pattern: one invocation
    // returns name + cpu + memUsage + memPct, and we parse it once.
    const [statsOut, dfOut, startedAt, psOut] = await Promise.all([
      run("docker", ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}", name]),
      run("docker", ["exec", name, "df", "-h", "/"]),
      run("docker", ["inspect", "--format", "{{.State.StartedAt}}", name]),
      run("docker", ["exec", name, "ps", "aux"]),
    ]);

    const statsRows = parseDockerStats(statsOut);
    const row = statsRows[0];
    const cpu = row?.cpu ?? 0;
    const memUsedGb = row?.memUsedGb ?? 0;
    const memTotalGb = row?.memTotalGb ?? 0;
    const memPct = row?.memPct ?? 0;

    // -- Disk usage inside the container --
    let diskPct = 0;
    if (dfOut) {
      const lines = dfOut.split("\n");
      if (lines.length >= 2) {
        const match = lines[1].match(/(\d+)%/);
        if (match) diskPct = parseInt(match[1], 10);
      }
    }

    // -- Uptime (container start time) --
    let uptime = "";
    if (startedAt) {
      const started = new Date(startedAt);
      if (!isNaN(started.getTime())) {
        const diffMs = Date.now() - started.getTime();
        const hours = Math.floor(diffMs / 3_600_000);
        const mins = Math.floor((diffMs % 3_600_000) / 60_000);
        uptime = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      }
    }

    // -- Running processes inside the container --
    const processes: ComputeProcess[] = [];
    if (psOut) {
      const lines = psOut.split("\n");
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split(/\s+/);
        if (parts.length < 11) continue;
        const cpuVal = parseFloat(parts[2]);
        if (cpuVal <= 0.0) continue;
        processes.push({
          pid: parts[1],
          cpu: parts[2],
          mem: parts[3],
          command: parts.slice(10).join(" "),
          workingDir: "",
        });
      }
      processes.sort((a, b) => parseFloat(b.cpu) - parseFloat(a.cpu));
      processes.splice(8); // keep top 8
    }

    // -- Docker container info for the snapshot (reuses the single stats parse) --
    const image = ((compute.config as Record<string, unknown>).image as string) ?? "";
    const docker = statsRows.map((r) => ({
      name: r.name,
      cpu: r.cpuRaw,
      memory: r.memRaw,
      image,
      project: compute.name,
    }));

    const metrics: ComputeMetrics = {
      cpu,
      memUsedGb,
      memTotalGb,
      memPct,
      diskPct,
      netRxMb: 0,
      netTxMb: 0,
      uptime,
      idleTicks: 0,
    };

    return { metrics, sessions: [], processes, docker };
  }

  // ── Port probing ─────────────────────────────────────────────────────────

  async probePorts(compute: Compute, ports: PortDecl[]): Promise<PortStatus[]> {
    const name = containerName(compute.name);

    return Promise.all(
      ports.map(async (decl) => {
        // Try inside the container first
        const hexPort = decl.port.toString(16).padStart(4, "0").toUpperCase();
        const out = await run("docker", [
          "exec",
          name,
          "bash",
          "-c",
          `cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '{print $2}' | grep -i ':${hexPort}'`,
        ]);
        if (out) return { ...decl, listening: true };

        // Fallback: check on the host side (port mapping)
        const listening = await checkHostPort(decl.port);
        return { ...decl, listening };
      }),
    );
  }

  // ── Sync ─────────────────────────────────────────────────────────────────

  async syncEnvironment(_compute: Compute, _opts: SyncOpts): Promise<void> {
    // Docker uses volume mounts, not sync.
    // Credentials are mounted at container creation time.
  }

  async checkSession(_compute: Compute, tmuxSessionId: string): Promise<boolean> {
    const { sessionExistsAsync } = await import("../../../core/infra/tmux.js");
    return sessionExistsAsync(tmuxSessionId);
  }

  getAttachCommand(_compute: Compute, session: Session): string[] {
    if (!session.session_id) return [];
    return [tmuxBin(), "attach", "-t", session.session_id];
  }

  buildChannelConfig(
    sessionId: string,
    stage: string,
    channelPort: number,
    _opts?: { conductorUrl?: string },
  ): Record<string, unknown> {
    return {
      sessionId,
      stage,
      channelPort,
    };
  }

  buildLaunchEnv(_session: Session): Record<string, string> {
    return {};
  }
}

// ── Unit helpers ─────────────────────────────────────────────────────────────

/** Convert a numeric value in MiB/GiB/KiB to GiB. */
function toGb(value: number, unit: string): number {
  switch (unit) {
    case "GiB":
      return Math.round(value * 100) / 100;
    case "MiB":
      return Math.round((value / 1024) * 100) / 100;
    case "KiB":
      return Math.round((value / (1024 * 1024)) * 100) / 100;
    default:
      return 0;
  }
}

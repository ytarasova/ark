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
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";

const execFileAsync = promisify(execFile);
import type {
  ComputeProvider, ProvisionOpts, LaunchOpts, SyncOpts,
  ComputeSnapshot, ComputeMetrics, ComputeProcess, PortDecl, PortStatus,
} from "../../types.js";
import type { Compute, Session } from "../../../core/store.js";
import { mergeComputeConfig, updateCompute } from "../../../core/store.js";
import { buildDevcontainer, detectDevcontainer } from "./devcontainer.js";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_IMAGE = "ubuntu:22.04";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Run a command asynchronously, return trimmed stdout or "" on failure. */
async function run(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: 30_000,
      encoding: "utf-8",
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Build the container name from a host name. */
export function containerName(hostName: string): string {
  return `ark-${hostName}`;
}

/** Check whether Docker daemon is reachable. */
async function assertDockerAvailable(): Promise<void> {
  try {
    await execFileAsync("docker", ["info"], {
      timeout: 10_000,
    });
  } catch {
    throw new Error("Docker is not available. Is the Docker daemon running?");
  }
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class DockerProvider implements ComputeProvider {
  readonly name = "docker";
  readonly isolationModes = [
    { value: "container", label: "Docker container (isolated)" },
  ];

  // ── Provision ────────────────────────────────────────────────────────────

  async provision(compute: Compute, _opts?: ProvisionOpts): Promise<void> {
    await assertDockerAvailable();

    const cfg = compute.config as Record<string, unknown>;
    const name = containerName(compute.name);
    const useDevcontainer = Boolean(cfg.devcontainer);
    const image = (cfg.image as string) || DEFAULT_IMAGE;
    const extraVolumes = (cfg.volumes as string[]) ?? [];

    updateCompute(compute.name, { status: "provisioning" });

    try {
      if (useDevcontainer) {
        // Devcontainer path — delegate to `devcontainer up`
        const workdir = (cfg.workdir as string) || process.cwd();
        if (!detectDevcontainer(workdir)) {
          throw new Error(`No devcontainer.json found in ${workdir}`);
        }
        const result = await buildDevcontainer(workdir);
        if (!result.ok) {
          throw new Error(`devcontainer up failed: ${result.error}`);
        }
        mergeComputeConfig(compute.name, {
          container_name: name,
          devcontainer: true,
          workdir,
        });
      } else {
        // Plain Docker path — pull image, create persistent container
        await execFileAsync("docker", ["pull", image], {
          timeout: 300_000, // images can be large
        });

        const home = homedir();
        const createArgs = [
          "create",
          "--name", name,
          "-it",
          // Mount credentials read-only
          "-v", `${join(home, ".ssh")}:/root/.ssh:ro`,
          "-v", `${join(home, ".claude")}:/root/.claude:ro`,
        ];

        // Optional AWS creds
        const awsDir = join(home, ".aws");
        if (existsSync(awsDir)) {
          createArgs.push("-v", `${awsDir}:/root/.aws:ro`);
        }

        // Extra volumes from config
        for (const vol of extraVolumes) {
          createArgs.push("-v", vol);
        }

        createArgs.push(image, "bash");

        await execFileAsync("docker", createArgs, {
          timeout: 30_000,
        });

        // Start the container
        await execFileAsync("docker", ["start", name], {
          timeout: 15_000,
        });

        // Read back the real container ID
        const containerId = await run("docker", [
          "inspect", "--format", "{{.Id}}", name,
        ]);

        mergeComputeConfig(compute.name, {
          image,
          container_id: containerId || name,
          container_name: name,
        });
      }

      updateCompute(compute.name, { status: "running" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      mergeComputeConfig(compute.name, { last_error: message });
      updateCompute(compute.name, { status: "stopped" });
      throw err;
    }
  }

  // ── Start / Stop ─────────────────────────────────────────────────────────

  async start(compute: Compute): Promise<void> {
    const name = containerName(compute.name);
    try {
      await execFileAsync("docker", ["start", name], {
        timeout: 15_000,
      });
    } catch (err) {
      throw new Error(`Failed to start container ${name}: ${err instanceof Error ? err.message : err}`);
    }
    updateCompute(compute.name, { status: "running" });
  }

  async stop(compute: Compute): Promise<void> {
    const name = containerName(compute.name);
    try {
      await execFileAsync("docker", ["stop", name], {
        timeout: 15_000,
      });
    } catch { /* container may already be stopped */ }
    updateCompute(compute.name, { status: "stopped" });
  }

  // ── Destroy ──────────────────────────────────────────────────────────────

  async destroy(compute: Compute): Promise<void> {
    const name = containerName(compute.name);
    try {
      await execFileAsync("docker", ["rm", "-f", name], {
        timeout: 15_000,
      });
    } catch { /* container may not exist */ }
    updateCompute(compute.name, { status: "destroyed" });
  }

  // ── Launch ───────────────────────────────────────────────────────────────

  async launch(_compute: Compute, _session: Session, opts: LaunchOpts): Promise<string> {
    const { createSessionAsync, writeLauncher } = await import("../../../core/tmux.js");

    const cfg = _compute.config as Record<string, unknown>;
    const name = (cfg.container_name as string) || containerName(_compute.name);
    const useDevcontainer = Boolean(cfg.devcontainer);

    let shellCmd: string;

    if (useDevcontainer) {
      const workdir = (cfg.workdir as string) || opts.workdir;
      // Write launcher locally, then exec via devcontainer
      const launcherPath = writeLauncher(opts.tmuxName, opts.launcherContent);
      shellCmd = `devcontainer exec --workspace-folder '${workdir}' -- bash ${launcherPath}`;
    } else {
      // Write launcher locally, then docker exec it
      const launcherPath = writeLauncher(opts.tmuxName, opts.launcherContent);
      shellCmd = `docker exec -it ${name} bash ${launcherPath}`;
    }

    await createSessionAsync(opts.tmuxName, shellCmd);
    return opts.tmuxName;
  }

  // ── Attach ───────────────────────────────────────────────────────────────

  async attach(_compute: Compute, _session: Session): Promise<void> {
    // No tunnels needed for local Docker — tmux attach handled by CLI layer
  }

  // ── Session lifecycle ─────────────────────────────────────────────────

  async killAgent(_compute: Compute, session: Session): Promise<void> {
    // Docker sessions run via tmux wrapping docker exec
    if (session.session_id) {
      const { killSessionAsync } = await import("../../../core/tmux.js");
      await killSessionAsync(session.session_id);
    }
  }

  async captureOutput(_compute: Compute, session: Session, opts?: { lines?: number }): Promise<string> {
    if (!session.session_id) return "";
    const { capturePane } = await import("../../../core/tmux.js");
    return capturePane(session.session_id, opts);
  }

  async cleanupSession(compute: Compute, _session: Session): Promise<void> {
    // Docker: stop the container (don't destroy — that's a compute-level op)
    const name = containerName(compute.name);
    try {
      await execFileAsync("docker", ["stop", name], {
        timeout: 15_000,
      });
    } catch { /* already stopped */ }
  }

  // ── Metrics ──────────────────────────────────────────────────────────────

  async getMetrics(compute: Compute): Promise<ComputeSnapshot> {
    const name = containerName(compute.name);

    // Run all independent docker commands in parallel - non-blocking
    const [statsOut, dfOut, startedAt, psOut, dockerStatsOut] = await Promise.all([
      run("docker", [
        "stats", "--no-stream", "--format",
        "{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}",
        name,
      ]),
      run("docker", ["exec", name, "df", "-h", "/"]),
      run("docker", [
        "inspect", "--format", "{{.State.StartedAt}}", name,
      ]),
      run("docker", ["exec", name, "ps", "aux"]),
      run("docker", [
        "stats", "--no-stream", "--format",
        "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}",
        name,
      ]),
    ]);

    // -- Container-level CPU / MEM from docker stats --
    let cpu = 0;
    let memUsedGb = 0;
    let memTotalGb = 0;
    let memPct = 0;

    if (statsOut) {
      const parts = statsOut.split("\t");
      if (parts.length >= 3) {
        cpu = parseFloat(parts[0].replace("%", "")) || 0;
        memPct = parseFloat(parts[2].replace("%", "")) || 0;
        // MemUsage looks like "123.4MiB / 7.776GiB"
        const memMatch = parts[1].match(
          /([\d.]+)\s*(MiB|GiB|KiB)\s*\/\s*([\d.]+)\s*(MiB|GiB|KiB)/,
        );
        if (memMatch) {
          memUsedGb = toGb(parseFloat(memMatch[1]), memMatch[2]);
          memTotalGb = toGb(parseFloat(memMatch[3]), memMatch[4]);
        }
      }
    }

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

    // -- Docker container info for the snapshot --
    const docker: { name: string; cpu: string; memory: string; image: string; project: string }[] = [];
    if (dockerStatsOut) {
      for (const line of dockerStatsOut.split("\n").filter(Boolean)) {
        const [cName, cCpu, cMemory] = line.split("\t");
        docker.push({
          name: cName?.trim() ?? "",
          cpu: cCpu?.trim() ?? "",
          memory: cMemory?.trim() ?? "",
          image: ((compute.config as Record<string, unknown>).image as string) ?? "",
          project: compute.name,
        });
      }
    }

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

    return Promise.all(ports.map(async (decl) => {
      let listening = false;
      try {
        // Try inside the container first (common for containerized services)
        const out = await run("docker", [
          "exec", name, "bash", "-c",
          `cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '{print $2}' | grep -i ':${decl.port.toString(16).padStart(4, "0").toUpperCase()}'`,
        ]);
        if (out) listening = true;
      } catch { /* not listening */ }

      if (!listening) {
        // Fallback: check on the host side (port mapping)
        try {
          const { stdout } = await execFileAsync("lsof", ["-i", `:${decl.port}`, "-sTCP:LISTEN"], {
            encoding: "utf-8", timeout: 5000,
          });
          listening = stdout.trim().length > 0;
        } catch { /* not listening */ }
      }

      return { ...decl, listening };
    }));
  }

  // ── Sync ─────────────────────────────────────────────────────────────────

  async syncEnvironment(_compute: Compute, _opts: SyncOpts): Promise<void> {
    // Docker uses volume mounts, not sync.
    // Credentials are mounted at container creation time.
  }
}

// ── Unit helpers ─────────────────────────────────────────────────────────────

/** Convert a numeric value in MiB/GiB/KiB to GiB. */
function toGb(value: number, unit: string): number {
  switch (unit) {
    case "GiB": return Math.round(value * 100) / 100;
    case "MiB": return Math.round((value / 1024) * 100) / 100;
    case "KiB": return Math.round((value / (1024 * 1024)) * 100) / 100;
    default: return 0;
  }
}

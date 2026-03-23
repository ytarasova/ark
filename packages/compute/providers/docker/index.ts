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

import { execFileSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import type {
  ComputeProvider, ProvisionOpts, LaunchOpts, SyncOpts,
  HostSnapshot, HostMetrics, HostProcess, PortDecl, PortStatus,
} from "../../types.js";
import type { Host, Session } from "../../../core/store.js";
import { mergeHostConfig, updateHost } from "../../../core/store.js";
import { buildDevcontainer, detectDevcontainer } from "./devcontainer.js";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_IMAGE = "ubuntu:22.04";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Run a command, return trimmed stdout or "" on failure. */
function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, {
      timeout: 30_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

/** Build the container name from a host name. */
export function containerName(hostName: string): string {
  return `ark-${hostName}`;
}

/** Check whether Docker daemon is reachable. */
function assertDockerAvailable(): void {
  try {
    execFileSync("docker", ["info"], {
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Docker is not available. Is the Docker daemon running?");
  }
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class DockerProvider implements ComputeProvider {
  readonly name = "docker";

  // ── Provision ────────────────────────────────────────────────────────────

  async provision(host: Host, _opts?: ProvisionOpts): Promise<void> {
    assertDockerAvailable();

    const cfg = host.config as Record<string, unknown>;
    const name = containerName(host.name);
    const useDevcontainer = Boolean(cfg.devcontainer);
    const image = (cfg.image as string) || DEFAULT_IMAGE;
    const extraVolumes = (cfg.volumes as string[]) ?? [];

    updateHost(host.name, { status: "provisioning" });

    try {
      if (useDevcontainer) {
        // Devcontainer path — delegate to `devcontainer up`
        const workdir = (cfg.workdir as string) || process.cwd();
        if (!detectDevcontainer(workdir)) {
          throw new Error(`No devcontainer.json found in ${workdir}`);
        }
        const result = buildDevcontainer(workdir);
        if (!result.ok) {
          throw new Error(`devcontainer up failed: ${result.error}`);
        }
        mergeHostConfig(host.name, {
          container_name: name,
          devcontainer: true,
          workdir,
        });
      } else {
        // Plain Docker path — pull image, create persistent container
        execFileSync("docker", ["pull", image], {
          timeout: 300_000, // images can be large
          stdio: ["pipe", "pipe", "pipe"],
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
        try {
          execFileSync("test", ["-d", awsDir], { stdio: "pipe" });
          createArgs.push("-v", `${awsDir}:/root/.aws:ro`);
        } catch { /* no .aws directory */ }

        // Extra volumes from config
        for (const vol of extraVolumes) {
          createArgs.push("-v", vol);
        }

        createArgs.push(image, "bash");

        execFileSync("docker", createArgs, {
          timeout: 30_000,
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Start the container
        execFileSync("docker", ["start", name], {
          timeout: 15_000,
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Read back the real container ID
        const containerId = run("docker", [
          "inspect", "--format", "{{.Id}}", name,
        ]);

        mergeHostConfig(host.name, {
          image,
          container_id: containerId || name,
          container_name: name,
        });
      }

      updateHost(host.name, { status: "running" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      mergeHostConfig(host.name, { last_error: message });
      updateHost(host.name, { status: "stopped" });
      throw err;
    }
  }

  // ── Start / Stop ─────────────────────────────────────────────────────────

  async start(host: Host): Promise<void> {
    const name = containerName(host.name);
    try {
      execFileSync("docker", ["start", name], {
        timeout: 15_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      throw new Error(`Failed to start container ${name}: ${err instanceof Error ? err.message : err}`);
    }
    updateHost(host.name, { status: "running" });
  }

  async stop(host: Host): Promise<void> {
    const name = containerName(host.name);
    try {
      execFileSync("docker", ["stop", name], {
        timeout: 15_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch { /* container may already be stopped */ }
    updateHost(host.name, { status: "stopped" });
  }

  // ── Destroy ──────────────────────────────────────────────────────────────

  async destroy(host: Host): Promise<void> {
    const name = containerName(host.name);
    try {
      execFileSync("docker", ["rm", "-f", name], {
        timeout: 15_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch { /* container may not exist */ }
    updateHost(host.name, { status: "destroyed" });
  }

  // ── Launch ───────────────────────────────────────────────────────────────

  async launch(_host: Host, _session: Session, opts: LaunchOpts): Promise<string> {
    const { createSession, writeLauncher } = await import("../../../core/tmux.js");

    const cfg = _host.config as Record<string, unknown>;
    const name = (cfg.container_name as string) || containerName(_host.name);
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

    createSession(opts.tmuxName, shellCmd);
    return opts.tmuxName;
  }

  // ── Attach ───────────────────────────────────────────────────────────────

  async attach(_host: Host, _session: Session): Promise<void> {
    // No tunnels needed for local Docker — tmux attach handled by CLI layer
  }

  // ── Metrics ──────────────────────────────────────────────────────────────

  async getMetrics(host: Host): Promise<HostSnapshot> {
    const name = containerName(host.name);

    // -- Container-level CPU / MEM from docker stats --
    let cpu = 0;
    let memUsedGb = 0;
    let memTotalGb = 0;
    let memPct = 0;

    const statsOut = run("docker", [
      "stats", "--no-stream", "--format",
      "{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}",
      name,
    ]);

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
    const dfOut = run("docker", ["exec", name, "df", "-h", "/"]);
    if (dfOut) {
      const lines = dfOut.split("\n");
      if (lines.length >= 2) {
        const match = lines[1].match(/(\d+)%/);
        if (match) diskPct = parseInt(match[1], 10);
      }
    }

    // -- Uptime (container start time) --
    let uptime = "";
    const startedAt = run("docker", [
      "inspect", "--format", "{{.State.StartedAt}}", name,
    ]);
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
    const processes: HostProcess[] = [];
    const psOut = run("docker", ["exec", name, "ps", "aux"]);
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
    const dockerStatsOut = run("docker", [
      "stats", "--no-stream", "--format",
      "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}",
      name,
    ]);
    if (dockerStatsOut) {
      for (const line of dockerStatsOut.split("\n").filter(Boolean)) {
        const [cName, cCpu, cMemory] = line.split("\t");
        docker.push({
          name: cName?.trim() ?? "",
          cpu: cCpu?.trim() ?? "",
          memory: cMemory?.trim() ?? "",
          image: ((host.config as Record<string, unknown>).image as string) ?? "",
          project: host.name,
        });
      }
    }

    const metrics: HostMetrics = {
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

  async probePorts(host: Host, ports: PortDecl[]): Promise<PortStatus[]> {
    const name = containerName(host.name);

    return ports.map((decl) => {
      let listening = false;
      try {
        // Try inside the container first (common for containerized services)
        const out = run("docker", [
          "exec", name, "bash", "-c",
          `cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '{print $2}' | grep -i ':${decl.port.toString(16).padStart(4, "0").toUpperCase()}'`,
        ]);
        if (out) listening = true;
      } catch { /* not listening */ }

      if (!listening) {
        // Fallback: check on the host side (port mapping)
        try {
          const out = execFileSync("lsof", ["-i", `:${decl.port}`, "-sTCP:LISTEN"], {
            encoding: "utf-8", timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"],
          });
          listening = out.trim().length > 0;
        } catch { /* not listening */ }
      }

      return { ...decl, listening };
    });
  }

  // ── Sync ─────────────────────────────────────────────────────────────────

  async syncEnvironment(_host: Host, _opts: SyncOpts): Promise<void> {
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

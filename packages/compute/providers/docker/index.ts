/**
 * Docker compute provider -- runs sessions in local Docker containers.
 * No SSH or remote host needed; everything is local but containerized.
 */

import { execFileSync } from "child_process";
import type {
  ComputeProvider, ProvisionOpts, LaunchOpts, SyncOpts,
  HostSnapshot, PortDecl, PortStatus,
} from "../../types.js";
import type { Host, Session } from "../../../core/store.js";
import { updateHost } from "../../../core/store.js";

export class DockerProvider implements ComputeProvider {
  readonly name = "docker";

  async provision(host: Host, _opts?: ProvisionOpts): Promise<void> {
    // Docker doesn't need provisioning in the traditional sense
    // The container is created at launch time
    updateHost(host.name, { status: "running" });
  }

  async destroy(host: Host): Promise<void> {
    // Stop and remove any containers for this host
    const containerId = (host.config as any)?.container_id;
    if (containerId) {
      try {
        execFileSync("docker", ["rm", "-f", containerId], { stdio: "pipe" });
      } catch { /* container may not exist */ }
    }
    updateHost(host.name, { status: "destroyed" });
  }

  async start(host: Host): Promise<void> {
    const containerId = (host.config as any)?.container_id;
    if (containerId) {
      execFileSync("docker", ["start", containerId], { stdio: "pipe" });
    }
    updateHost(host.name, { status: "running" });
  }

  async stop(host: Host): Promise<void> {
    const containerId = (host.config as any)?.container_id;
    if (containerId) {
      try {
        execFileSync("docker", ["stop", containerId], { stdio: "pipe" });
      } catch { /* already stopped */ }
    }
    updateHost(host.name, { status: "stopped" });
  }

  async launch(_host: Host, _session: Session, opts: LaunchOpts): Promise<string> {
    // For Docker provider, launch runs the command inside a container
    // The container setup (devcontainer or plain docker run) happens here
    // For now, use tmux locally wrapping a docker exec
    const { createSession, writeLauncher } = await import("../../../core/tmux.js");
    const launcher = writeLauncher(opts.tmuxName, opts.launcherContent);
    createSession(opts.tmuxName, `bash ${launcher}`);
    return opts.tmuxName;
  }

  async attach(_host: Host, _session: Session): Promise<void> {
    // No tunnels needed for local Docker
  }

  async getMetrics(_host: Host): Promise<HostSnapshot> {
    // Collect Docker-specific metrics
    const metrics = { cpu: 0, memUsedGb: 0, memTotalGb: 0, memPct: 0, diskPct: 0, netRxMb: 0, netTxMb: 0, uptime: "", idleTicks: 0 };
    const docker: any[] = [];

    try {
      const stats = execFileSync("docker", ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"], {
        encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      for (const line of stats.split("\n").filter(Boolean)) {
        const [name, cpu, memory] = line.split("\t");
        docker.push({ name: name ?? "", cpu: cpu?.trim() ?? "", memory: memory?.trim() ?? "", image: "", project: name ?? "" });
      }
    } catch { /* docker not available or no containers */ }

    return { metrics, sessions: [], processes: [], docker };
  }

  async probePorts(_host: Host, ports: PortDecl[]): Promise<PortStatus[]> {
    // Same as local - check if ports are listening
    return ports.map((decl) => {
      let listening = false;
      try {
        const out = execFileSync("lsof", ["-i", `:${decl.port}`, "-sTCP:LISTEN"], {
          encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
        });
        listening = out.trim().length > 0;
      } catch { /* not listening */ }
      return { ...decl, listening };
    });
  }

  async syncEnvironment(_host: Host, _opts: SyncOpts): Promise<void> {
    // Docker uses volume mounts, not sync
    // Credentials are mounted at container creation time
  }
}

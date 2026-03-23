/**
 * Local compute provider -- runs sessions on the local machine.
 * No provisioning needed. Uses existing tmux module for session management.
 */

import { execFileSync } from "child_process";
import type {
  ComputeProvider, ProvisionOpts, LaunchOpts, SyncOpts,
  HostSnapshot, PortDecl, PortStatus,
} from "../../types.js";
import type { Host, Session } from "../../../core/store.js";
import * as tmux from "../../../core/tmux.js";
import { collectLocalMetrics } from "./metrics.js";

export class LocalProvider implements ComputeProvider {
  readonly name = "local";
  /** Local host is a singleton - it's your machine, always running */
  readonly singleton = true;

  async provision(_host: Host, _opts?: ProvisionOpts): Promise<void> {
    // No-op: your machine is already provisioned
  }
  async destroy(_host: Host): Promise<void> {
    throw new Error("Cannot destroy the local host");
  }
  async start(_host: Host): Promise<void> {
    // No-op: your machine is always running
  }
  async stop(_host: Host): Promise<void> {
    throw new Error("Cannot stop the local host");
  }

  async launch(_host: Host, _session: Session, opts: LaunchOpts): Promise<string> {
    const launcher = tmux.writeLauncher(opts.tmuxName, opts.launcherContent);
    tmux.createSession(opts.tmuxName, `bash ${launcher}`);
    return opts.tmuxName;
  }

  async attach(_host: Host, _session: Session): Promise<void> {
    // Local attach: no tunnels needed, tmux attach handled by CLI layer
  }

  async getMetrics(_host: Host): Promise<HostSnapshot> {
    return collectLocalMetrics();
  }

  async probePorts(_host: Host, ports: PortDecl[]): Promise<PortStatus[]> {
    return ports.map((decl) => {
      let listening = false;
      try {
        const out = execFileSync("lsof", ["-i", `:${decl.port}`, "-sTCP:LISTEN"], {
          encoding: "utf-8", timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        listening = out.trim().length > 0;
      } catch { /* not listening */ }
      return { ...decl, listening };
    });
  }

  async syncEnvironment(_host: Host, _opts: SyncOpts): Promise<void> {
    // No-op: local machine shares the filesystem
  }
}

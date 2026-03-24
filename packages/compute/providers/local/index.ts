/**
 * Local compute provider -- runs sessions on the local machine.
 * No provisioning needed. Uses existing tmux module for session management.
 */

import { execFileSync, spawn } from "child_process";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import type {
  ComputeProvider, ProvisionOpts, LaunchOpts, SyncOpts,
  ComputeSnapshot, PortDecl, PortStatus,
} from "../../types.js";
import type { Compute, Session } from "../../../core/store.js";
import { WORKTREES_DIR } from "../../../core/store.js";
import * as tmux from "../../../core/tmux.js";
import { collectLocalMetrics } from "./metrics.js";

export class LocalProvider implements ComputeProvider {
  readonly name = "local";
  /** Local compute is a singleton - it's your machine, always running */
  readonly singleton = true;

  async provision(_compute: Compute, _opts?: ProvisionOpts): Promise<void> {
    // No-op: your machine is already provisioned
  }
  async destroy(_compute: Compute): Promise<void> {
    throw new Error("Cannot destroy the local compute");
  }
  async start(_compute: Compute): Promise<void> {
    // No-op: your machine is always running
  }
  async stop(_compute: Compute): Promise<void> {
    throw new Error("Cannot stop the local compute");
  }

  async launch(_compute: Compute, _session: Session, opts: LaunchOpts): Promise<string> {
    const launcher = tmux.writeLauncher(opts.tmuxName, opts.launcherContent);
    tmux.createSession(opts.tmuxName, `bash ${launcher}`);
    return opts.tmuxName;
  }

  async attach(_compute: Compute, _session: Session): Promise<void> {
    // Local attach: no tunnels needed, tmux attach handled by CLI layer
  }

  async killAgent(_compute: Compute, session: Session): Promise<void> {
    if (session.session_id) {
      await tmux.killSessionAsync(session.session_id);
    }
  }

  async captureOutput(_compute: Compute, session: Session, opts?: { lines?: number }): Promise<string> {
    if (!session.session_id) return "";
    return tmux.capturePane(session.session_id, opts);
  }

  async cleanupSession(_compute: Compute, session: Session): Promise<void> {
    // Only clean up worktree if one exists — direct repos are a noop
    const wtPath = join(WORKTREES_DIR(), session.id);
    if (!existsSync(wtPath)) return;

    const repo = session.workdir ?? session.repo;
    if (repo) {
      const ok = await new Promise<boolean>((resolve) => {
        const cp = spawn("git", ["-C", repo!, "worktree", "remove", "--force", wtPath], { stdio: "pipe" });
        cp.on("close", (code: number | null) => resolve(code === 0));
        cp.on("error", () => resolve(false));
      });
      if (!ok) {
        try { rmSync(wtPath, { recursive: true, force: true }); } catch {}
      }
    } else {
      try { rmSync(wtPath, { recursive: true, force: true }); } catch {}
    }
  }

  async getMetrics(_compute: Compute): Promise<ComputeSnapshot> {
    return collectLocalMetrics();
  }

  async probePorts(_compute: Compute, ports: PortDecl[]): Promise<PortStatus[]> {
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

  async syncEnvironment(_compute: Compute, _opts: SyncOpts): Promise<void> {
    // No-op: local machine shares the filesystem
  }
}

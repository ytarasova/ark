/**
 * Local compute provider -- runs sessions on the local machine.
 * No provisioning needed. Uses existing tmux module for session management.
 */

import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const execFileAsync = promisify(execFile);
import type {
  ComputeProvider, ProvisionOpts, LaunchOpts, SyncOpts,
  ComputeSnapshot, PortDecl, PortStatus, Compute, Session,
} from "../../types.js";
import type { AppContext } from "../../../core/app.js";
import * as tmux from "../../../core/infra/tmux.js";
import { collectLocalMetrics } from "./metrics.js";
import { safeAsync } from "../../../core/safe.js";
import { DEFAULT_CONDUCTOR_URL } from "../../../core/constants.js";
import { channelLaunchSpec } from "../../../core/install-paths.js";

/** Check if a port is listening locally. */
async function checkLocalPort(port: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-i", `:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf-8", timeout: 5000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export class LocalProvider implements ComputeProvider {
  readonly name = "local";
  readonly singleton = true;
  readonly isolationModes = [
    { value: "worktree", label: "Git worktree (isolated)" },
    { value: "inplace", label: "In-place (direct)" },
  ];
  readonly canReboot = false;
  readonly canDelete = false;
  readonly supportsWorktree = true;
  readonly initialStatus = "running";
  readonly needsAuth = false;

  private app!: AppContext;

  setApp(app: AppContext): void {
    this.app = app;
  }

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
    const launcher = tmux.writeLauncher(opts.tmuxName, opts.launcherContent, this.app.config.tracksDir);
    await tmux.createSessionAsync(opts.tmuxName, `bash ${launcher}`, { arkDir: this.app.config.arkDir });
    return opts.tmuxName;
  }

  async attach(_compute: Compute, _session: Session): Promise<void> {
    // Local attach: no tunnels needed, tmux attach handled by CLI layer
  }

  async killAgent(_compute: Compute, session: Session): Promise<void> {
    if (!session.session_id) return;
    await tmux.killSessionAsync(session.session_id);
  }

  async captureOutput(_compute: Compute, session: Session, opts?: { lines?: number }): Promise<string> {
    if (!session.session_id) return "";
    return tmux.capturePaneAsync(session.session_id, opts);
  }

  async cleanupSession(_compute: Compute, session: Session): Promise<void> {
    const wtPath = join(this.app.config.worktreesDir, session.id);
    if (!existsSync(wtPath)) return;

    const repo = session.workdir ?? session.repo;
    if (repo) {
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

  /**
   * Populates all ComputeSnapshot fields: metrics, sessions, processes, docker.
   * netRxMb/netTxMb and idleTicks are always 0 (macOS doesn't expose /proc/net/dev).
   */
  async getMetrics(_compute: Compute): Promise<ComputeSnapshot> {
    return collectLocalMetrics();
  }

  async probePorts(_compute: Compute, ports: PortDecl[]): Promise<PortStatus[]> {
    return Promise.all(ports.map(async (decl) => {
      const listening = await checkLocalPort(decl.port);
      return { ...decl, listening };
    }));
  }

  async syncEnvironment(_compute: Compute, _opts: SyncOpts): Promise<void> {
    // No-op: local machine shares the filesystem
  }

  async checkSession(_compute: Compute, tmuxSessionId: string): Promise<boolean> {
    return tmux.sessionExistsAsync(tmuxSessionId);
  }

  getAttachCommand(_compute: Compute, session: Session): string[] {
    if (!session.session_id) return [];
    return [tmux.tmuxBin(), "attach", "-t", session.session_id];
  }

  buildChannelConfig(sessionId: string, stage: string, channelPort: number, opts?: { conductorUrl?: string }): Record<string, unknown> {
    // channelLaunchSpec() returns the compiled-binary self-spawn in prod and
    // the bun-runtime + source-path spawn in dev. Replaces the old approach
    // that hardcoded bun + CHANNEL_SCRIPT_PATH, which broke in compiled
    // binaries because the path lived in Bun's virtual FS.
    const spec = channelLaunchSpec();
    return {
      command: spec.command,
      args: spec.args,
      env: {
        ARK_SESSION_ID: sessionId,
        ARK_STAGE: stage,
        ARK_CHANNEL_PORT: String(channelPort),
        ARK_CONDUCTOR_URL: opts?.conductorUrl ?? DEFAULT_CONDUCTOR_URL,
      },
    };
  }

  buildLaunchEnv(_session: Session): Record<string, string> {
    return {};
  }
}

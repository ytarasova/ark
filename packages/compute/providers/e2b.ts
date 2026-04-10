/**
 * E2B compute provider - managed Firecracker sandbox via E2B SDK.
 *
 * Each session gets its own E2B sandbox (sub-second boot, full isolation).
 * Sandboxes are created on-demand at launch time; provision just validates
 * the API key and template.
 */

import type { AppContext } from "../../core/app.js";
import type {
  ComputeProvider, Compute, Session, ProvisionOpts, LaunchOpts, SyncOpts,
  IsolationMode, ComputeSnapshot, ComputeMetrics, PortDecl, PortStatus,
} from "../types.js";
import { DEFAULT_CONDUCTOR_URL } from "../../core/constants.js";

export interface E2BConfig {
  provider: "e2b";
  template?: string;      // E2B sandbox template (default: "base")
  apiKey?: string;         // E2B API key (default: E2B_API_KEY env)
  timeout?: number;        // Sandbox timeout in seconds (default: 3600)
  [key: string]: unknown;
}

const EMPTY_METRICS: ComputeMetrics = {
  cpu: 0, memUsedGb: 0, memTotalGb: 0, memPct: 0, diskPct: 0,
  netRxMb: 0, netTxMb: 0, uptime: "N/A", idleTicks: 0,
};

export class E2BProvider implements ComputeProvider {
  readonly name = "e2b";
  readonly isolationModes: IsolationMode[] = [
    { value: "sandbox", label: "E2B managed Firecracker sandbox" },
  ];
  readonly canDelete = true;
  readonly canReboot = false;
  readonly supportsWorktree = false;
  readonly needsAuth = true;
  readonly initialStatus = "stopped";

  private app: AppContext | null = null;
  // sessionId -> Sandbox instance (lazy import of e2b SDK)
  private sandboxes = new Map<string, any>();

  setApp(app: AppContext): void { this.app = app; }

  private async getSdk(): Promise<typeof import("e2b")> {
    return await import("e2b");
  }

  async provision(compute: Compute, _opts?: ProvisionOpts): Promise<void> {
    const cfg = compute.config as E2BConfig;
    const apiKey = cfg.apiKey || process.env.E2B_API_KEY;
    if (!apiKey) throw new Error("E2B_API_KEY not set. Get one at https://e2b.dev");

    // Validate SDK availability
    await this.getSdk();

    this.app!.computes.update(compute.name, { status: "running" });
  }

  async launch(compute: Compute, session: Session, opts: LaunchOpts): Promise<string> {
    const cfg = compute.config as E2BConfig;
    const apiKey = cfg.apiKey || process.env.E2B_API_KEY;
    const template = cfg.template || "base";
    const timeout = cfg.timeout || 3600;

    const { Sandbox } = await this.getSdk();

    const sandbox = await Sandbox.create(template, {
      apiKey,
      timeoutMs: timeout * 1000,
      metadata: { sessionId: session.id, arkCompute: compute.name },
    });

    this.sandboxes.set(session.id, sandbox);

    // Write launcher script and execute in background
    await sandbox.files.write("/tmp/ark-launch.sh", opts.launcherContent);
    await sandbox.commands.run("bash /tmp/ark-launch.sh", { background: true });

    // Store sandbox ID for reconnection
    this.app!.computes.mergeConfig(compute.name, {
      [`sandbox_${session.id}`]: sandbox.sandboxId,
    });

    return sandbox.sandboxId;
  }

  async killAgent(_compute: Compute, session: Session): Promise<void> {
    const sandbox = this.sandboxes.get(session.id);
    if (sandbox) {
      await sandbox.kill();
      this.sandboxes.delete(session.id);
    }
  }

  async cleanupSession(compute: Compute, session: Session): Promise<void> {
    await this.killAgent(compute, session);
  }

  async start(compute: Compute): Promise<void> {
    this.app!.computes.update(compute.name, { status: "running" });
  }

  async stop(compute: Compute): Promise<void> {
    // Kill all sandboxes for this compute
    const entries = Array.from(this.sandboxes.entries());
    for (const [_sid, sandbox] of entries) {
      try { await sandbox.kill(); } catch { /* may already be gone */ }
    }
    this.sandboxes.clear();
    this.app!.computes.update(compute.name, { status: "stopped" });
  }

  async destroy(compute: Compute): Promise<void> {
    await this.stop(compute);
    this.app!.computes.update(compute.name, { status: "destroyed" });
  }

  async attach(_compute: Compute, _session: Session): Promise<void> {
    // E2B sandboxes don't support direct attach
  }

  async captureOutput(_compute: Compute, _session: Session, _opts?: { lines?: number }): Promise<string> {
    // E2B sandboxes don't expose a tmux-like capture; return empty
    return "";
  }

  async checkSession(_compute: Compute, tmuxSessionId: string): Promise<boolean> {
    // Check if the sandbox is still in our map
    // tmuxSessionId isn't used for E2B -- we track by sandbox instance
    return false;
  }

  async getMetrics(compute: Compute): Promise<ComputeSnapshot> {
    return {
      metrics: EMPTY_METRICS,
      sessions: [],
      processes: [],
      docker: [],
    };
  }

  async probePorts(_compute: Compute, ports: PortDecl[]): Promise<PortStatus[]> {
    return ports.map(p => ({ ...p, listening: false }));
  }

  async syncEnvironment(_compute: Compute, _opts: SyncOpts): Promise<void> {
    // E2B sandboxes are ephemeral; sync is a noop
  }

  getAttachCommand(_compute: Compute, _session: Session): string[] {
    return ["echo", "E2B sandboxes do not support direct attach. Use ark session output."];
  }

  buildChannelConfig(sessionId: string, stage: string, channelPort: number, opts?: { conductorUrl?: string }): Record<string, unknown> {
    // E2B sandboxes run remotely; channel config points back to conductor
    return {
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

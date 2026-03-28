/**
 * ArkdBackedProvider — abstract base class for providers that delegate
 * operations to an arkd daemon running on the compute target.
 *
 * Implements: killAgent, captureOutput, checkSession, getMetrics, probePorts, launch
 * Subclasses must implement: provision, destroy, start, stop, attach, cleanupSession,
 *   syncEnvironment, getAttachCommand, buildChannelConfig, buildLaunchEnv, getArkdUrl
 */

import { ArkdClient } from "../../arkd/client.js";
import type {
  ComputeProvider, ProvisionOpts, LaunchOpts, SyncOpts,
  ComputeSnapshot, PortDecl, PortStatus, Compute, Session, IsolationMode,
} from "../types.js";

export abstract class ArkdBackedProvider implements ComputeProvider {
  abstract readonly name: string;
  abstract readonly isolationModes: IsolationMode[];
  abstract readonly canReboot: boolean;
  abstract readonly canDelete: boolean;
  abstract readonly supportsWorktree: boolean;
  abstract readonly initialStatus: string;
  abstract readonly needsAuth: boolean;

  // ── Abstract: provider-specific ─────────────────────────────────────────

  abstract provision(compute: Compute, opts?: ProvisionOpts): Promise<void>;
  abstract destroy(compute: Compute): Promise<void>;
  abstract start(compute: Compute): Promise<void>;
  abstract stop(compute: Compute): Promise<void>;

  abstract attach(compute: Compute, session: Session): Promise<void>;
  abstract cleanupSession(compute: Compute, session: Session): Promise<void>;
  abstract syncEnvironment(compute: Compute, opts: SyncOpts): Promise<void>;

  abstract getAttachCommand(compute: Compute, session: Session): string[];
  abstract buildChannelConfig(sessionId: string, stage: string, channelPort: number, opts?: { conductorUrl?: string }): Record<string, unknown>;
  abstract buildLaunchEnv(session: Session): Record<string, string>;

  /** Returns the base URL for the arkd instance on this compute target. */
  abstract getArkdUrl(compute: Compute): string;

  // ── Concrete: delegated to arkd ─────────────────────────────────────────

  protected getClient(compute: Compute): ArkdClient {
    return new ArkdClient(this.getArkdUrl(compute));
  }

  async launch(_compute: Compute, _session: Session, opts: LaunchOpts): Promise<string> {
    const client = this.getClient(_compute);
    await client.launchAgent({
      sessionName: opts.tmuxName,
      script: opts.launcherContent,
      workdir: opts.workdir,
    });
    return opts.tmuxName;
  }

  async killAgent(compute: Compute, session: Session): Promise<void> {
    if (!session.session_id) return;
    const client = this.getClient(compute);
    await client.killAgent({ sessionName: session.session_id });
  }

  async captureOutput(compute: Compute, session: Session, opts?: { lines?: number }): Promise<string> {
    if (!session.session_id) return "";
    const client = this.getClient(compute);
    const res = await client.captureOutput({
      sessionName: session.session_id,
      lines: opts?.lines,
    });
    return res.output;
  }

  async checkSession(compute: Compute, tmuxSessionId: string): Promise<boolean> {
    const client = this.getClient(compute);
    const res = await client.agentStatus({ sessionName: tmuxSessionId });
    return res.running;
  }

  async getMetrics(compute: Compute): Promise<ComputeSnapshot> {
    const client = this.getClient(compute);
    const snap = await client.snapshot();
    // SnapshotRes shape matches ComputeSnapshot exactly
    return snap as unknown as ComputeSnapshot;
  }

  async probePorts(compute: Compute, ports: PortDecl[]): Promise<PortStatus[]> {
    const client = this.getClient(compute);
    const res = await client.probePorts(ports.map(p => p.port));
    return ports.map(decl => {
      const found = res.results.find(r => r.port === decl.port);
      return { ...decl, listening: found?.listening ?? false };
    });
  }
}

/**
 * ArkdBackedProvider - abstract base class for providers that delegate
 * operations to an arkd daemon running on the compute target.
 *
 * Implements: killAgent, captureOutput, checkSession, getMetrics, probePorts, launch
 * Subclasses must implement: provision, destroy, start, stop, attach, cleanupSession,
 *   syncEnvironment, getAttachCommand, buildChannelConfig, buildLaunchEnv, getArkdUrl
 */

import { ArkdClient } from "../../arkd/client/index.js";
import type { AppContext } from "../../core/app.js";
import type {
  ComputeProvider,
  ProvisionOpts,
  LaunchOpts,
  SyncOpts,
  ComputeSnapshot,
  PortDecl,
  PortStatus,
  Compute,
  Session,
  IsolationMode,
} from "../types.js";

export abstract class ArkdBackedProvider implements ComputeProvider {
  abstract readonly name: string;
  abstract readonly isolationModes: IsolationMode[];
  abstract readonly singleton: boolean;
  abstract readonly canReboot: boolean;
  abstract readonly canDelete: boolean;
  abstract readonly supportsWorktree: boolean;
  abstract readonly initialStatus: string;
  abstract readonly needsAuth: boolean;
  /**
   * Arkd-backed providers (local + EC2 families) never mount cluster-side
   * Secrets; they rely on env injection + bind-mounts. Only k8s-family
   * providers override this to `true`.
   */
  readonly supportsSecretMount: boolean = false;

  constructor(protected readonly app: AppContext) {}

  // ── Abstract: provider-specific ─────────────────────────────────────────

  abstract provision(compute: Compute, opts?: ProvisionOpts): Promise<void>;
  abstract destroy(compute: Compute): Promise<void>;
  abstract start(compute: Compute): Promise<void>;
  abstract stop(compute: Compute): Promise<void>;

  abstract attach(compute: Compute, session: Session): Promise<void>;
  abstract cleanupSession(compute: Compute, session: Session): Promise<void>;
  abstract syncEnvironment(compute: Compute, opts: SyncOpts): Promise<void>;

  abstract getAttachCommand(compute: Compute, session: Session): string[];
  abstract buildChannelConfig(
    sessionId: string,
    stage: string,
    channelPort: number,
    opts?: { conductorUrl?: string },
  ): Record<string, unknown>;
  abstract buildLaunchEnv(session: Session): Record<string, string>;

  /** Returns the base URL for the arkd instance on this compute target. */
  abstract getArkdUrl(compute: Compute, session?: Session): string;

  /**
   * Per-compute override for the arkd HTTP client request timeout (ms).
   * Returning `undefined` keeps the ArkdClient default (30s).
   *
   * Subclasses that read a request-timeout from their compute config
   * (e.g. RemoteConfig.arkd_request_timeout_ms) override this so the
   * client honours the operator-configured value.
   */
  protected getArkdRequestTimeoutMs(_compute: Compute): number | undefined {
    return undefined;
  }

  // ── Concrete: delegated to arkd ─────────────────────────────────────────

  protected getClient(compute: Compute, session?: Session): ArkdClient {
    const timeoutMs = this.getArkdRequestTimeoutMs(compute);
    return new ArkdClient(this.getArkdUrl(compute, session), timeoutMs ? { requestTimeoutMs: timeoutMs } : undefined);
  }

  async launch(compute: Compute, session: Session, opts: LaunchOpts): Promise<string> {
    const client = this.getClient(compute, session);
    await client.launchAgent({
      sessionName: opts.tmuxName,
      script: opts.launcherContent,
      workdir: opts.workdir,
    });
    return opts.tmuxName;
  }

  // ── Generic process supervisor (claude-agent runtime + future runtimes) ───

  async spawnProcess(
    compute: Compute,
    session: Session,
    opts: {
      handle: string;
      cmd: string;
      args: string[];
      workdir: string;
      env?: Record<string, string>;
      logPath?: string;
    },
  ): Promise<{ pid: number }> {
    const client = this.getClient(compute, session);
    const res = await client.spawnProcess(opts);
    return { pid: res.pid };
  }

  async killProcessByHandle(
    compute: Compute,
    session: Session,
    handle: string,
    signal?: "SIGTERM" | "SIGKILL",
  ): Promise<{ wasRunning: boolean }> {
    const client = this.getClient(compute, session);
    const res = await client.killProcess({ handle, signal });
    return { wasRunning: res.wasRunning };
  }

  async statusProcessByHandle(
    compute: Compute,
    session: Session,
    handle: string,
  ): Promise<{ running: boolean; pid?: number; exitCode?: number }> {
    const client = this.getClient(compute, session);
    return client.statusProcess({ handle });
  }

  async killAgent(compute: Compute, session: Session): Promise<void> {
    if (!session.session_id) return;
    const client = this.getClient(compute, session);
    await client.killAgent({ sessionName: session.session_id });
  }

  async captureOutput(compute: Compute, session: Session, opts?: { lines?: number }): Promise<string> {
    if (!session.session_id) return "";
    const client = this.getClient(compute, session);
    const res = await client.captureOutput({
      sessionName: session.session_id,
      lines: opts?.lines,
    });
    return res.output;
  }

  async sendUserMessage(compute: Compute, session: Session, content: string): Promise<{ delivered: boolean }> {
    if (!session.session_id) {
      throw new Error("session has no active agent (session_id is null)");
    }
    const client = this.getClient(compute, session);
    // Publish on the global `user-input` channel with `control: "interrupt"`.
    //
    // The Anthropic Agent SDK only calls `next()` on its AsyncIterable
    // prompt BETWEEN turns -- a mid-turn user message would otherwise sit
    // in the PromptQueue silently until the current tool call finishes,
    // which can be minutes. The user expects their message to take
    // precedence over the in-flight work.
    //
    // The agent's user-message-stream consumer fires `onMessage(content)`
    // (pushes content into the prompt queue) and then `onInterrupt()`
    // (aborts the active query). The SDK's resume loop in launch.ts then
    // starts a fresh query with `resume: <sessionId>` so prior context is
    // preserved, and the new user message is at the head of the queue
    // ready to be consumed on the first `next()` of the new query.
    //
    // This is the documented abort+resume pattern from the SDK:
    //   - sdk.d.ts:1090-1094  AbortController in query options
    //   - sdk.d.ts:1470-1472  resume parameter to restart with history
    const res = await client.publishToChannel("user-input", {
      session: session.session_id,
      content,
      control: "interrupt",
    });
    return { delivered: res.delivered };
  }

  async checkSession(compute: Compute, tmuxSessionId: string, session?: Session): Promise<boolean> {
    const client = this.getClient(compute, session);
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
    const res = await client.probePorts(ports.map((p) => p.port));
    return ports.map((decl) => {
      const found = res.results.find((r) => r.port === decl.port);
      return { ...decl, listening: found?.listening ?? false };
    });
  }
}

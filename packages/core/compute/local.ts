/**
 * LocalCompute -- the host running `ark` itself. No provisioning, no stop,
 * no destroy: arkd runs on localhost:<config.ports.arkd> and the conductor
 * talks to it directly.
 *
 * Snapshot is not supported (the host cannot be serialised); snapshot()
 * and restore() throw `NotSupportedError`.
 */

import type { AppContext } from "../app.js";
import { ArkdClient } from "../../arkd/client/index.js";
import { attachComputeMethods, type ArkdClientFactory } from "./handle-helpers.js";
import type {
  Compute,
  ComputeCapabilities,
  ComputeHandle,
  ComputeKind,
  FlushPlacementOpts,
  ProvisionOpts,
  Snapshot,
} from "./types.js";
import { NotSupportedError } from "./types.js";
import { LocalPlacementCtx } from "./local-placement-ctx.js";
import { DEFAULT_ARKD_URL, DEFAULT_CONDUCTOR_URL } from "../constants.js";
import { channelLaunchSpec } from "../install-paths.js";
import type { Session } from "../../types/session.js";

export class LocalCompute implements Compute {
  readonly kind: ComputeKind = "local";
  readonly capabilities: ComputeCapabilities = {
    snapshot: false,
    pool: false,
    networkIsolation: false,
    provisionLatency: "instant",
    // The host running ark itself: only one row per tenant, can't be deleted,
    // can't be rebooted, shares the conductor's filesystem (worktree-friendly).
    singleton: true,
    canDelete: false,
    canReboot: false,
    supportsWorktree: true,
    supportsSecretMount: false,
    needsAuth: false,
    initialStatus: "running",
    isolationModes: [
      { value: "worktree", label: "Worktree" },
      { value: "inplace", label: "In-place" },
    ],
  };

  constructor(private readonly app: AppContext) {}

  /** Test-only: swap in a stub `ArkdClient` factory for `getMetrics`. */
  setClientFactoryForTesting(factory: ArkdClientFactory): void {
    this.clientFactory = factory;
  }

  private clientFactory: ArkdClientFactory = (url) => new ArkdClient(url);

  async provision(opts: ProvisionOpts): Promise<ComputeHandle> {
    // The host is always provisioned. We just mint a handle.
    const name = (opts.tags?.name as string | undefined) ?? "local";
    const handle: ComputeHandle = {
      kind: this.kind,
      name,
      meta: { ...(opts.config ?? {}) },
    };
    return attachComputeMethods(handle, () => this.getArkdUrl(handle), this.clientFactory);
  }

  attachExistingHandle(row: { name: string; status: string; config: Record<string, unknown> }): ComputeHandle | null {
    // The host is always "provisioned" -- there's no underlying instance to
    // create. Synthesize a handle directly from the row so the dispatcher
    // skips the redundant provision() call.
    const handle: ComputeHandle = {
      kind: this.kind,
      name: row.name,
      meta: { ...row.config },
    };
    return attachComputeMethods(handle, () => this.getArkdUrl(handle), this.clientFactory);
  }

  async start(_h: ComputeHandle): Promise<void> {
    throw new NotSupportedError(this.kind, "start");
  }

  async stop(_h: ComputeHandle): Promise<void> {
    throw new NotSupportedError(this.kind, "stop");
  }

  async destroy(_h: ComputeHandle): Promise<void> {
    throw new NotSupportedError(this.kind, "destroy");
  }

  getArkdUrl(_h: ComputeHandle): string {
    return `http://localhost:${this.app.config.ports.arkd}`;
  }

  async ensureReachable(h: ComputeHandle): Promise<void> {
    // Local arkd shares a host with the conductor; no transport to set up.
    // BUT: the conductor's hooks-channel subscriber still needs to attach so
    // hooks the agent publishes to /channel/hooks/publish are drained and
    // re-emitted as session events. EC2 wires this via provisionStep
    // "events-consumer-start"; the local path was silently missing it,
    // which left every hook-published-locally invisible to the conductor
    // (no agent_message, no PreToolUse / PostToolUse, no Stop) and broke
    // every UI feature that depends on the event stream. Idempotent:
    // startArkdEventsConsumer is a no-op for an already-attached compute.
    const arkdUrl = this.getArkdUrl(h);
    const { startArkdEventsConsumer } = await import("../services/channel/arkd-events-consumer.js");
    startArkdEventsConsumer(this.app, h.name, arkdUrl, process.env.ARK_ARKD_TOKEN ?? null);
  }

  // resolveWorkdir intentionally omitted: LocalCompute shares the
  // conductor's filesystem layout, so callers fall back to
  // `session.workdir` (the conductor-side path is the right path).

  // ── flushPlacement ────────────────────────────────────────────────────────
  //
  // Replay queued typed-secret placement ops onto the local filesystem. The
  // conductor's filesystem IS the compute's filesystem, so writes land where
  // the agent will read.
  //
  // Today's `LocalPlacementCtx` is a `NoopPlacementCtx` subclass (Phase 2 --
  // file-typed secrets are dropped with a debug log). When that's swapped for
  // a real impl in Phase 3 nothing here needs to change: the queue contract
  // and the PlacementCtx interface stay stable.
  //
  // No-op when the deferred queue is empty (env-only sessions). Idempotent:
  // appendFile is marker-keyed; writeFile overwrites by path.

  /**
   * Test-only: swap the LocalPlacementCtx factory so unit tests can assert
   * which ctx the flush replays onto without exercising the real
   * file-system / NoopPlacementCtx pair.
   */
  setPlacementCtxFactoryForTesting(fn: () => import("../secrets/placement-types.js").PlacementCtx): void {
    this.placementCtxFactory = fn;
  }

  private placementCtxFactory: () => import("../secrets/placement-types.js").PlacementCtx = () =>
    new LocalPlacementCtx();

  async flushPlacement(_h: ComputeHandle, opts: FlushPlacementOpts): Promise<void> {
    if (!opts.placement.hasDeferred()) return;
    const ctx = this.placementCtxFactory();
    await opts.placement.flush(ctx);
  }

  async snapshot(_h: ComputeHandle): Promise<Snapshot> {
    throw new NotSupportedError(this.kind, "snapshot");
  }

  async restore(_s: Snapshot): Promise<ComputeHandle> {
    throw new NotSupportedError(this.kind, "restore");
  }

  // ── buildChannelConfig ──────────────────────────────────────────────────
  //
  // Local channel server runs the conductor's bun (compiled mode self-spawns
  // via channelLaunchSpec). Mirrors the shape every claude-code agent
  // expects in `.mcp.json`'s `mcpServers["ark-channel"]`.

  buildChannelConfig(
    sessionId: string,
    stage: string,
    channelPort: number,
    opts?: { conductorUrl?: string },
  ): Record<string, unknown> {
    const spec = channelLaunchSpec();
    return {
      command: spec.command,
      args: spec.args,
      env: {
        ARK_SESSION_ID: sessionId,
        ARK_STAGE: stage,
        ARK_CHANNEL_PORT: String(channelPort),
        ARK_CONDUCTOR_URL: opts?.conductorUrl ?? DEFAULT_CONDUCTOR_URL,
        ARK_ARKD_URL: DEFAULT_ARKD_URL,
      },
    };
  }

  buildLaunchEnv(_session: Session): Record<string, string> {
    return {};
  }

  getAttachCommand(_h: ComputeHandle, session: Session): string[] {
    if (!session.session_id) return [];
    return ["tmux", "attach", "-t", session.session_id];
  }
}

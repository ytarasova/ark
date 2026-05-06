/**
 * Compute layer types - provider interface and shared models.
 */

import type { Compute, Session } from "../../types/index.js";
import type { PlacementCtx } from "../secrets/placement-types.js";

// Re-export for convenience
export type { Compute, Session };

// ── Provider interface ──────────────────────────────────────────────────────

export interface ProvisionOpts {
  size?: string;
  arch?: string;
  tags?: Record<string, string>;
  onLog?: (msg: string) => void;
}

export interface LaunchOpts {
  tmuxName: string;
  workdir: string;
  launcherContent: string;
  ports: PortDecl[];
  /**
   * Optional deferred PlacementCtx produced by the dispatcher's pre-launch
   * placement pass (see core/secrets/deferred-placement-ctx.ts). Providers
   * whose medium isn't ready until provision-time (EC2 family, anything
   * keyed off `compute.config.instance_id`) flush its queued file ops onto
   * a real ctx after `provider.start`/`provider.provision` has populated
   * the instance address and before the agent process is spawned.
   * Providers that can place pre-launch (k8s) leave this field unread.
   */
  placement?: PlacementCtx;
}

export interface SyncOpts {
  direction: "push" | "pull";
  categories?: string[];
  projectFiles?: string[];
  projectDir?: string;
  onLog?: (msg: string) => void;
}

export interface IsolationMode {
  value: string;
  label: string;
}

export interface ComputeProvider {
  readonly name: string;

  /** Isolation modes this provider supports. Empty = no isolation choice needed. */
  readonly isolationModes: IsolationMode[];

  // ── Compute lifecycle ───────────────────────────────────────────────────
  provision(compute: Compute, opts?: ProvisionOpts): Promise<void>;
  destroy(compute: Compute): Promise<void>;
  start(compute: Compute): Promise<void>;
  stop(compute: Compute): Promise<void>;

  // ── Session lifecycle ───────────────────────────────────────────────────
  launch(compute: Compute, session: Session, opts: LaunchOpts): Promise<string>;
  attach(compute: Compute, session: Session): Promise<void>;

  /**
   * Generic process spawn on this compute (no tmux, no agent semantics). The
   * agent runtime decides what to spawn -- a launcher script for claude-agent,
   * `tmux new-session ...` for claude-code, etc. Returns the pid arkd assigned;
   * the caller's `handle` is the bookkeeping key for subsequent kill/status.
   *
   * Optional so providers that don't talk to arkd (e.g. a pure-tmux local
   * provider, if any survive) can omit it; callers that need this must check
   * for undefined and surface a clear error.
   */
  spawnProcess?(
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
  ): Promise<{ pid: number }>;

  /** Kill a previously-spawned process by handle (the runtime's bookkeeping key). */
  killProcessByHandle?(
    compute: Compute,
    session: Session,
    handle: string,
    signal?: "SIGTERM" | "SIGKILL",
  ): Promise<{ wasRunning: boolean }>;

  /** Status of a previously-spawned process by handle. */
  statusProcessByHandle?(
    compute: Compute,
    session: Session,
    handle: string,
  ): Promise<{ running: boolean; pid?: number; exitCode?: number }>;

  /** Kill the agent process for a session. */
  killAgent(compute: Compute, session: Session): Promise<void>;

  /** Capture live output from the agent process. */
  captureOutput(compute: Compute, session: Session, opts?: { lines?: number }): Promise<string>;

  /**
   * Publish a steer / user message to a running agent (claude-agent runtime).
   * For arkd-backed providers this publishes on the global `user-input`
   * channel (`POST /channel/user-input/publish`) with envelope `{ session,
   * content }`; the agent's user-message-stream consumer subscribes to the
   * same channel, filters envelopes by session id, and pushes content into
   * its PromptQueue. Optional so legacy providers can opt out -- callers
   * that get `undefined` here MUST fall back to the local-tmux send path
   * explicitly rather than silently no-op. Returns true when arkd reported
   * the message was handed to a parked subscriber; false means it was
   * buffered for a not-yet-attached consumer (still queued, will be
   * delivered on connect).
   */
  sendUserMessage?(compute: Compute, session: Session, content: string): Promise<{ delivered: boolean }>;

  /** Clean up session resources (worktrees, remote checkouts, etc). */
  cleanupSession(compute: Compute, session: Session): Promise<void>;

  // ── Monitoring ──────────────────────────────────────────────────────────
  getMetrics(compute: Compute): Promise<ComputeSnapshot>;
  probePorts(compute: Compute, ports: PortDecl[]): Promise<PortStatus[]>;

  /** Check the actual provider status and reconcile with DB. Returns null if not applicable. */
  checkStatus?(compute: Compute): Promise<string | null>;

  /** Reboot the compute instance and wait for it to come back. */
  reboot?(
    compute: Compute,
    opts?: { onLog?: (msg: string) => void; onProgress?: (msg: string) => void },
  ): Promise<void>;

  /** Get the ArkD daemon URL for this compute target. Pass the session when
   *  available so the URL prefers the session's own SSM tunnel port (#423)
   *  over the per-compute fallback. */
  getArkdUrl?(compute: Compute, session?: Session): string;

  /**
   * Where the agent should `cd` and where the launcher should write embedded
   * project-local files (`.mcp.json`, `.claude/settings.local.json`). Local
   * providers leave this `undefined` -- the executor falls back to its own
   * `effectiveWorkdir` (the laptop-side worktree). Remote providers return
   * the path the cloned worktree lives at on the target host (e.g.
   * `/home/ubuntu/Projects/<repo>` for EC2). Without this hook the launcher
   * embeds the conductor's local Mac path, which doesn't exist on Ubuntu --
   * `cd` fails and heredoc-written files land under a phantom path.
   */
  resolveWorkdir?(compute: Compute, session: Session): string | null;

  syncEnvironment(compute: Compute, opts: SyncOpts): Promise<void>;

  /**
   * Build a `PlacementCtx` for the given session/compute pair so the typed-secret
   * placement dispatch can write files, append blocks, set env vars, and configure
   * the provisioner against this provider's medium (SSM-via-arkd, k8s API, fs, ...).
   *
   * Optional in Phase 1: providers without an impl get the no-op fallback (placement
   * does not run for that compute), preserving the legacy claude-auth + stage/runtime
   * secrets-resolve paths. Phase 2 adds real impls (EC2 first); Phase 3 retires the
   * legacy paths once every provider has one.
   */
  buildPlacementCtx?(session: Session, compute: Compute): Promise<PlacementCtx>;

  // ── Capability flags ────────────────────────────────────────────────────
  //
  // All non-optional: rules are driven off these flags in ComputeService,
  // so a missing flag would silently fall back to `undefined`/falsy and
  // skip the rule. Every provider must declare each flag explicitly.
  readonly singleton: boolean;
  readonly canReboot: boolean;
  readonly canDelete: boolean;
  readonly supportsWorktree: boolean;
  readonly initialStatus: string;
  readonly needsAuth: boolean;
  /**
   * Provider can mount a cluster-side Secret (or equivalent) at launch time.
   * True for k8s-family providers (vanilla pod + Kata microVM); false for
   * everything else (local/docker/devcontainer/firecracker/EC2), which rely
   * on env injection + host bind-mounts. Drives the dispatch-time claude
   * auth materialization path in `dispatch-claude-auth.ts`.
   */
  readonly supportsSecretMount: boolean;

  // ── Session lifecycle (extended) ──────────────────────────────────────
  /** Probe whether the agent's tmux pane is alive on the worker. Pass the
   *  session when available so the arkd RPC routes via the per-session SSM
   *  tunnel (#423); without session, falls back to the compute-level URL. */
  checkSession(compute: Compute, tmuxSessionId: string, session?: Session): Promise<boolean>;
  getAttachCommand(compute: Compute, session: Session): string[];
  buildChannelConfig(
    sessionId: string,
    stage: string,
    channelPort: number,
    opts?: { conductorUrl?: string },
  ): Record<string, unknown>;
  buildLaunchEnv(session: Session): Record<string, string>;
}

// ── Metrics types ───────────────────────────────────────────────────────────

export interface ComputeMetrics {
  cpu: number;
  memUsedGb: number;
  memTotalGb: number;
  memPct: number;
  diskPct: number;
  netRxMb: number;
  netTxMb: number;
  uptime: string;
  idleTicks: number;
}

export interface ComputeSession {
  name: string;
  status: string;
  mode: string;
  projectPath: string;
  cpu: number;
  mem: number;
}

export interface ComputeProcess {
  pid: string;
  cpu: string;
  mem: string;
  command: string;
  workingDir: string;
}

export interface DockerContainer {
  name: string;
  cpu: string;
  memory: string;
  image: string;
  project: string;
}

export interface ComputeSnapshot {
  metrics: ComputeMetrics;
  sessions: ComputeSession[];
  processes: ComputeProcess[];
  docker: DockerContainer[];
}

// ── Port types ──────────────────────────────────────────────────────────────

export interface PortDecl {
  port: number;
  name?: string;
  source: string;
}

export interface PortStatus extends PortDecl {
  listening: boolean;
}

// ── Provider config types ───────────────────────────────────────────────────

export type { K8sConfig } from "./providers/k8s.js";

// ── arc.json types ──────────────────────────────────────────────────────────

/**
 * Compose configuration embedded in arc.json. Users may declare any of:
 *   - a `file` path to an existing compose file (defaults to docker-compose.yml)
 *   - an `inline` compose spec (serialized to a tempfile at prepare time)
 *   - both, in which case they are merged via `docker compose -f A -f B`
 */
export interface ArcComposeConfig {
  /** Path to an existing docker-compose.yml, relative to repo. Default `docker-compose.yml`. */
  file?: string;
  /** Inline compose spec (services/networks/volumes/etc.). Written to a tempfile. */
  inline?: Record<string, unknown>;
  /** Skip `docker compose up -d`. Default false. */
  skipUp?: boolean;
}

/** Devcontainer configuration embedded in arc.json. */
export interface ArcDevcontainerConfig {
  config?: string;
}

export interface ArcJson {
  ports?: Array<{ port: number; name?: string }>;
  sync?: string[];
  /**
   * Compose integration. `true` is sugar for `{ file: "docker-compose.yml" }`;
   * `false` / missing disables. Use an object for inline or custom file paths.
   */
  compose?: boolean | ArcComposeConfig;
  /** Devcontainer integration. `true` enables defaults; object lets you override. */
  devcontainer?: boolean | ArcDevcontainerConfig;
}

/**
 * Compute layer types - provider interface and shared models.
 */

import type { Compute, Session } from "../types/index.js";

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

  /** Inject AppContext reference so providers never need getApp(). */
  setApp?(app: import("../core/app.js").AppContext): void;

  // ── Compute lifecycle ───────────────────────────────────────────────────
  provision(compute: Compute, opts?: ProvisionOpts): Promise<void>;
  destroy(compute: Compute): Promise<void>;
  start(compute: Compute): Promise<void>;
  stop(compute: Compute): Promise<void>;

  // ── Session lifecycle ───────────────────────────────────────────────────
  launch(compute: Compute, session: Session, opts: LaunchOpts): Promise<string>;
  attach(compute: Compute, session: Session): Promise<void>;

  /** Kill the agent process for a session. */
  killAgent(compute: Compute, session: Session): Promise<void>;

  /** Capture live output from the agent process. */
  captureOutput(compute: Compute, session: Session, opts?: { lines?: number }): Promise<string>;

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

  /** Get the ArkD daemon URL for this compute target. */
  getArkdUrl?(compute: Compute): string;

  syncEnvironment(compute: Compute, opts: SyncOpts): Promise<void>;

  // ── Capability flags ────────────────────────────────────────────────────
  readonly singleton?: boolean;
  readonly canReboot: boolean;
  readonly canDelete: boolean;
  readonly supportsWorktree: boolean;
  readonly initialStatus: string;
  readonly needsAuth: boolean;

  // ── Session lifecycle (extended) ──────────────────────────────────────
  checkSession(compute: Compute, tmuxSessionId: string): Promise<boolean>;
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

export type { E2BConfig } from "./providers/e2b.js";
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

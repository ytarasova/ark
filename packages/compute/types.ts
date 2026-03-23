/**
 * Compute layer types - provider interface and shared models.
 */

import type { Compute, Session } from "../core/store.js";

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
}

export interface ComputeProvider {
  readonly name: string;

  provision(compute: Compute, opts?: ProvisionOpts): Promise<void>;
  destroy(compute: Compute): Promise<void>;
  start(compute: Compute): Promise<void>;
  stop(compute: Compute): Promise<void>;

  launch(compute: Compute, session: Session, opts: LaunchOpts): Promise<string>;
  attach(compute: Compute, session: Session): Promise<void>;

  getMetrics(compute: Compute): Promise<ComputeSnapshot>;
  probePorts(compute: Compute, ports: PortDecl[]): Promise<PortStatus[]>;

  syncEnvironment(compute: Compute, opts: SyncOpts): Promise<void>;
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

// ── arc.json types ──────────────────────────────────────────────────────────

export interface ArcJson {
  ports?: Array<{ port: number; name?: string }>;
  sync?: string[];
  compose?: boolean;
  devcontainer?: boolean;
}

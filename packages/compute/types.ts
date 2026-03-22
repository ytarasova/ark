/**
 * Compute layer types - provider interface and shared models.
 */

import type { Host, Session } from "../core/store.js";

// Re-export for convenience
export type { Host, Session };

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

  provision(host: Host, opts?: ProvisionOpts): Promise<void>;
  destroy(host: Host): Promise<void>;
  start(host: Host): Promise<void>;
  stop(host: Host): Promise<void>;

  launch(host: Host, session: Session, opts: LaunchOpts): Promise<string>;
  attach(host: Host, session: Session): Promise<void>;

  getMetrics(host: Host): Promise<HostSnapshot>;
  probePorts(host: Host, ports: PortDecl[]): Promise<PortStatus[]>;

  syncEnvironment(host: Host, opts: SyncOpts): Promise<void>;
}

// ── Metrics types ───────────────────────────────────────────────────────────

export interface HostMetrics {
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

export interface HostSession {
  name: string;
  status: string;
  mode: string;
  projectPath: string;
  cpu: number;
  mem: number;
}

export interface HostProcess {
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

export interface HostSnapshot {
  metrics: HostMetrics;
  sessions: HostSession[];
  processes: HostProcess[];
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

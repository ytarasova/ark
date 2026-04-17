// ── Types ──────────────────────────────────────────────────────────────────

export interface SnapshotMetrics {
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

export interface SnapshotSession {
  name: string;
  status: string;
  mode: string;
  projectPath: string;
  cpu: number;
  mem: number;
}

export interface SnapshotProcess {
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
  metrics: SnapshotMetrics;
  sessions: SnapshotSession[];
  processes: SnapshotProcess[];
  docker: DockerContainer[];
}

export interface MetricHistoryPoint {
  t: number;
  cpu: number;
  mem: number;
  disk: number;
}

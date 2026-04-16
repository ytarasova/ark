/**
 * ArkD - typed request/response contracts for the agent daemon HTTP API.
 *
 * Every compute target (local, Docker, EC2, Firecracker) runs an arkd
 * instance. Providers talk to it via ArkdClient instead of SSH/exec/tmux.
 */

// ── File operations ─────────────────────────────────────────────────────────

export interface ReadFileReq {
  path: string;
}
export interface ReadFileRes {
  content: string;
  size: number;
}

export interface WriteFileReq {
  path: string;
  content: string;
  mode?: number;
}
export interface WriteFileRes {
  ok: true;
  bytesWritten: number;
}

export interface ListDirReq {
  path: string;
  recursive?: boolean;
}
export interface ListDirRes {
  entries: DirEntry[];
}
export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink";
  size: number;
}

export interface StatReq {
  path: string;
}
export interface StatRes {
  exists: boolean;
  type?: "file" | "dir" | "symlink";
  size?: number;
  mtime?: string;
}

export interface MkdirReq {
  path: string;
  recursive?: boolean;
}
export interface MkdirRes {
  ok: true;
}

// ── Process execution ───────────────────────────────────────────────────────

export interface ExecReq {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number; // ms, default 30_000
  stdin?: string;
}
export interface ExecRes {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// ── Agent lifecycle ─────────────────────────────────────────────────────────

export interface AgentLaunchReq {
  sessionName: string; // tmux session name
  script: string; // launcher script content
  workdir: string;
}
export interface AgentLaunchRes {
  ok: true;
  pid?: number;
}

export interface AgentKillReq {
  sessionName: string;
}
export interface AgentKillRes {
  ok: true;
  wasRunning: boolean;
}

export interface AgentStatusReq {
  sessionName: string;
}
export interface AgentStatusRes {
  running: boolean;
  pid?: number;
}

export interface AgentCaptureReq {
  sessionName: string;
  lines?: number;
}
export interface AgentCaptureRes {
  output: string;
}

// ── System ──────────────────────────────────────────────────────────────────

export interface MetricsRes {
  cpu: number;
  memUsedGb: number;
  memTotalGb: number;
  memPct: number;
  diskPct: number;
  uptime: string;
}

export interface ProbePortsReq {
  ports: number[];
}
export interface ProbePortsRes {
  results: { port: number; listening: boolean }[];
}

export interface HealthRes {
  status: "ok";
  version: string;
  hostname: string;
  platform: string;
}

// ── System snapshot (full metrics + sessions + processes + docker) ───────────

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

export interface SnapshotContainer {
  name: string;
  cpu: string;
  memory: string;
  image: string;
  project: string;
}

export interface SnapshotRes {
  metrics: SnapshotMetrics;
  sessions: SnapshotSession[];
  processes: SnapshotProcess[];
  docker: SnapshotContainer[];
}

// ── Channel relay (arkd as conductor transport) ────────────────────────────

/** Agent report forwarded through arkd to conductor */
export interface ChannelReportReq {
  sessionId: string;
  report: Record<string, unknown>;
}
export interface ChannelReportRes {
  ok: boolean;
  forwarded: boolean;
  error?: string;
}

/** Agent-to-agent relay forwarded through arkd to conductor */
export interface ChannelRelayReq {
  from: string;
  target: string;
  message: string;
}
export interface ChannelRelayRes {
  ok: boolean;
  forwarded: boolean;
}

/** Conductor → agent delivery: arkd delivers to local channel port */
export interface ChannelDeliverReq {
  channelPort: number;
  payload: Record<string, unknown>;
}
export interface ChannelDeliverRes {
  ok: true;
  delivered: boolean;
}

/** Runtime config update */
export interface ConfigReq {
  conductorUrl?: string;
}
export interface ConfigRes {
  ok: true;
  conductorUrl: string | null;
}

// ── Error envelope ──────────────────────────────────────────────────────────

export interface ArkdError {
  error: string;
  code?: string;
}

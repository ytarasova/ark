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

// ── Generic process supervisor ───────────────────────────────────────────────
//
// arkd is a per-compute supervisor for *any* long-lived process. The agent
// runtime decides what to launch (a tmux session for claude-code, a plain
// `bash launcher.sh` for claude-agent, etc.); arkd just spawns + tracks the
// pid against a caller-supplied handle. No "agent" semantics here.

export interface ProcessSpawnReq {
  /**
   * Caller-provided handle for tracking. Must match the safe-name pattern
   * (alnum + dash/underscore, 1..64). Used as the key for kill / status.
   */
  handle: string;
  /** argv[0] -- the executable. Resolved via PATH. */
  cmd: string;
  /** argv[1..] */
  args: string[];
  /** Working directory for the child process. */
  workdir: string;
  /** Environment vars merged on top of arkd's own env. */
  env?: Record<string, string>;
  /**
   * Optional file path to capture stdout + stderr (appended). When omitted
   * the child's pipes are tied to /dev/null. The path is created with mkdir
   * -p on the directory; arkd does not enforce confinement here -- the
   * runtime that builds the launcher is responsible for keeping it inside
   * its session dir.
   */
  logPath?: string;
}
export interface ProcessSpawnRes {
  ok: true;
  pid: number;
}

export interface ProcessKillReq {
  handle: string;
  /** SIGTERM (default) or SIGKILL. */
  signal?: "SIGTERM" | "SIGKILL";
}
export interface ProcessKillRes {
  ok: true;
  /** False when the handle wasn't tracked or the pid was already gone. */
  wasRunning: boolean;
}

export interface ProcessStatusReq {
  handle: string;
}
export interface ProcessStatusRes {
  running: boolean;
  pid?: number;
  exitCode?: number;
}

// ── Agent lifecycle (LEGACY tmux wrappers) ───────────────────────────────────
//
// Kept for the claude-code runtime which still drives tmux directly. The
// claude-agent runtime moved to /process/* (generic) and /channel/* (generic).
// Phase C will retire these in favour of having claude-code build its own
// tmux argv and call /process/spawn the same way other runtimes do.

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

// ── Generic channel pub/sub ──────────────────────────────────────────────────
//
// Each runtime declares its own channel names (e.g. claude-agent uses
// "user-input" inbound and "hooks" outbound). arkd doesn't know what's IN
// any envelope -- it's just a typed JSON object on a per-channel queue.
// Multi-tenant isolation is by channel name; consumers pick the right channel
// for the runtime they expect.

export interface ChannelPublishReq {
  channel: string;
  /**
   * Caller-supplied envelope. arkd treats it as opaque JSON. Must be
   * serializable; arkd writes JSON.stringify(envelope) + "\n" on the wire.
   */
  envelope: Record<string, unknown>;
}
export interface ChannelPublishRes {
  ok: true;
  /**
   * True when arkd handed the envelope directly to a parked subscriber;
   * false when it was buffered for a not-yet-attached consumer (still
   * delivered eventually -- subscribers drain the buffered ring on connect).
   */
  delivered: boolean;
}

// ── Terminal attach (live) ──────────────────────────────────────────────────

/**
 * Open a live terminal stream for a tmux session. The response includes a
 * streamHandle used to correlate subsequent Input/Resize/Close calls and an
 * initial capture of the pane so the UI can render something before live
 * output begins streaming.
 */
export interface AgentAttachOpenReq {
  sessionName: string;
}
export interface AgentAttachOpenRes {
  ok: boolean;
  streamHandle: string;
  initialBuffer: string;
}

/** Send input keystrokes to a tmux session. Uses `send-keys -l` so escape sequences pass through literally. */
export interface AgentAttachInputReq {
  sessionName: string;
  data: string;
}
export interface AgentAttachInputRes {
  ok: boolean;
}

/** Resize the tmux window to the given cols/rows. */
export interface AgentAttachResizeReq {
  sessionName: string;
  cols: number;
  rows: number;
}
export interface AgentAttachResizeRes {
  ok: boolean;
}

/** Close a previously opened terminal stream. */
export interface AgentAttachCloseReq {
  streamHandle: string;
}
export interface AgentAttachCloseRes {
  ok: boolean;
}

/**
 * Stream live pane bytes for an open attach handle. Served as an HTTP chunked
 * response -- bytes from `tmux pipe-pane` are piped to the response body as
 * they arrive. The stream closes when the handle is closed via
 * /agent/attach/close, when the tmux session ends, or when the client
 * disconnects.
 *
 * The endpoint lives on the same arkd instance that owns the tmux session;
 * the server daemon's /terminal/:sessionId WS proxy relays bytes from this
 * stream back to the browser.
 */
export interface AgentAttachStreamReq {
  streamHandle: string;
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

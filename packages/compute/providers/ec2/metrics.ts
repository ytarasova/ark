/**
 * SSH-based metrics collection for EC2 hosts.
 * Ported from BigBox's dashboard/fetch.py + parse.py to TypeScript.
 */

import type {
  DockerContainer,
  ComputeMetrics,
  ComputeProcess,
  ComputeSession,
  ComputeSnapshot,
} from "../../types.js";
import { sshExec, sshExecAsync } from "./ssh.js";
import { REMOTE_PROJECTS_DIR } from "./constants.js";

// ---------------------------------------------------------------------------
// Internal sub-commands
// ---------------------------------------------------------------------------

/**
 * Iterates tmux sessions, finds the claude process in each pane, and outputs
 * tab-delimited lines: session_name, cpu%, mem%, cwd, mode (interactive|agentic).
 */
const CLAUDE_CMD = [
  "for sess in $(tmux list-sessions -F '#{session_name}' 2>/dev/null); do",
  "  pid=$(tmux list-panes -t \"$sess\" -F '#{pane_pid}' 2>/dev/null | head -1);",
  "  cwd=$(tmux display-message -t \"$sess\" -p '#{pane_current_path}' 2>/dev/null);",
  // Find the actual claude process among descendants of the pane shell
  "  cpid=$(pgrep -a -P $pid 2>/dev/null | grep -m1 claude | awk '{print $1}');",
  "  [ -z \"$cpid\" ] && cpid=$pid;",
  "  cpu=$(ps -p $cpid -o %cpu= 2>/dev/null | tr -d ' ');",
  "  mem=$(ps -p $cpid -o %mem= 2>/dev/null | tr -d ' ');",
  "  cmd=$(ps -p $cpid -o args= 2>/dev/null);",
  '  mode="interactive";',
  "  echo \"$cmd\" | grep -q 'dangerously' && mode=\"agentic\";",
  '  printf "%s\\t%s%%\\t%s%%\\t%s\\t%s\\n" "$sess" "$cpu" "$mem" "$cwd" "$mode";',
  "done",
].join(" ");

/**
 * Lists top 8 processes by CPU usage (>0.1%), outputting tab-delimited lines:
 * pid, cpu%, mem%, command, working_dir (relative to ~/Projects/).
 */
const PROCESSES_CMD = [
  "for pid in $(ps aux --sort=-%cpu",
  "| grep -vE 'sshd|grep|awk|ps aux|mpstat'",
  "| awk 'NR>1 && $3>0.1{print $2}' | head -8); do",
  "  cmd=$(ps -p $pid -o comm= 2>/dev/null);",
  "  [ -z \"$cmd\" ] && continue;",
  "  cpu=$(ps -p $pid -o %cpu= 2>/dev/null | tr -d ' ');",
  "  mem=$(ps -p $pid -o %mem= 2>/dev/null | tr -d ' ');",
  "  cwd=$(readlink /proc/$pid/cwd 2>/dev/null | sed 's|/home/ubuntu/Projects/||');",
  '  printf "%s\\t%s%%\\t%s%%\\t%s\\t%s\\n" "$pid" "$cpu" "$mem" "$cmd" "$cwd";',
  "done",
].join(" ");

/** Reads /proc/net/dev for eth0/ens interfaces, outputs "rx_mb tx_mb" in MiB. */
const NETWORK_CMD =
  "cat /proc/net/dev | awk '/eth0|ens/{printf \"%.1f %.1f\\n\", $2/1048576, $10/1048576}'";

/** Docker stats for all containers: tab-delimited name, cpu%, mem_usage. Falls back to "(none)". */
const DOCKER_CMD =
  "docker stats --no-stream --format '{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}' 2>/dev/null || echo \"(none)\"";

/** Lists running containers: tab-delimited name, image. Used to build image lookup for docker stats. */
const DOCKER_PS_CMD =
  "docker ps --format '{{.Names}}\\t{{.Image}}' 2>/dev/null";

// ---------------------------------------------------------------------------
// Exported SSH command strings
// ---------------------------------------------------------------------------

/** Single SSH command that outputs section-delimited fast metrics. */
export const SSH_FAST_CMD: string = [
  "echo \"=== CPU ===\" && { cpu=$(mpstat 1 1 2>/dev/null | tail -1 | awk 'NF>0{printf \"%.1f\", 100 - $NF}'); [ -n \"$cpu\" ] && echo \"$cpu\" || top -bn1 | awk '/^%?Cpu/{printf \"%.1f\\n\", 100 - $8}'; }",
  "echo \"=== MEMORY ===\" && free | awk '/Mem:/{printf \"%.1f %.1f\\n\", $3/1024, $2/1024}'",
  "echo \"=== DISK ===\" && df / | tail -1 | awk '{print $5}' | tr -d '%'",
  "echo \"=== UPTIME ===\" && uptime -p",
  "echo \"=== IDLE ===\" && cat /tmp/ark-idle-count 2>/dev/null || echo 0",
  "echo \"=== TMUX ===\" && tmux list-sessions 2>/dev/null || echo \"(none)\"",
  `echo "=== CLAUDE ===" && ${CLAUDE_CMD}`,
  `echo "=== PROCESSES ===" && ${PROCESSES_CMD}`,
  `echo "=== NETWORK ===" && ${NETWORK_CMD}`,
].join("\n");

/** SSH command for docker stats + docker ps. */
export const SSH_DOCKER_CMD: string = [
  `echo "=== DOCKER ===" && ${DOCKER_CMD}`,
  `echo "=== DOCKER_PS ===" && ${DOCKER_PS_CMD}`,
].join("\n");

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

const PROJECT_PREFIX = `${REMOTE_PROJECTS_DIR}/`;

function emptyMetrics(): ComputeMetrics {
  return {
    cpu: 0,
    memUsedGb: 0,
    memTotalGb: 0,
    memPct: 0,
    diskPct: 0,
    netRxMb: 0,
    netTxMb: 0,
    uptime: "",
    idleTicks: 0,
  };
}

function emptySnapshot(): ComputeSnapshot {
  return { metrics: emptyMetrics(), sessions: [], processes: [], docker: [] };
}

/** Split raw SSH output into named sections. */
function splitSections(stdout: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let cur: string | null = null;
  for (const ln of stdout.trim().split("\n")) {
    if (ln.startsWith("=== ")) {
      cur = ln.replace(/^=+\s*/, "").replace(/\s*=+$/, "");
      out[cur] = [];
    } else if (cur) {
      out[cur].push(ln.trim());
    }
  }
  return out;
}

function f(v: string | undefined, d = 0): number {
  if (v === undefined) return d;
  const n = parseFloat(v);
  return Number.isNaN(n) ? d : n;
}

function g(s: Record<string, string[]>, key: string, d = "0"): string {
  const arr = s[key];
  if (!arr || arr.length === 0) return d;
  return arr[0];
}

function parseMetrics(s: Record<string, string[]>): ComputeMetrics {
  const m = emptyMetrics();
  m.cpu = f(g(s, "CPU"));
  m.diskPct = f(g(s, "DISK"));

  const mp = g(s, "MEMORY", "0 16").split(/\s+/);
  if (mp.length >= 2) {
    m.memUsedGb = f(mp[0]) / 1024;
    m.memTotalGb = f(mp[1]) / 1024;
    m.memPct = m.memTotalGb > 0 ? (m.memUsedGb / m.memTotalGb) * 100 : 0;
  }

  const net = g(s, "NETWORK", "0 0").split(/\s+/);
  if (net.length >= 2) {
    m.netRxMb = f(net[0]);
    m.netTxMb = f(net[1]);
  }

  m.uptime = g(s, "UPTIME", "?");

  const idleStr = g(s, "IDLE", "0");
  const idleVal = parseInt(idleStr, 10);
  m.idleTicks = Number.isNaN(idleVal) ? 0 : idleVal;

  return m;
}

function parseSessions(s: Record<string, string[]>): ComputeSession[] {
  // Build Claude info lookup from CLAUDE section
  const claude: Record<
    string,
    { cpu: number; mem: number; cwd: string; mode: string }
  > = {};

  for (const ln of s["CLAUDE"] ?? []) {
    const p = ln.split("\t");
    if (p.length >= 4) {
      claude[p[0]] = {
        cpu: f(p[1].replace("%", "")),
        mem: f(p[2].replace("%", "")),
        cwd: p[3],
        mode: p.length >= 5 ? p[4] : "?",
      };
    }
  }

  const out: ComputeSession[] = [];
  for (const ln of s["TMUX"] ?? ["(none)"]) {
    if (ln === "(none)") continue;
    const nm = ln.split(":")[0].trim();
    const info = claude[nm];
    out.push({
      name: nm,
      status: (info?.cpu ?? 0) > 1 ? "working" : "idle",
      mode: info?.mode ?? "?",
      projectPath: (info?.cwd ?? "").replace(PROJECT_PREFIX, ""),
      cpu: info?.cpu ?? 0,
      mem: info?.mem ?? 0,
    });
  }
  return out;
}

function parseProcesses(s: Record<string, string[]>): ComputeProcess[] {
  const out: ComputeProcess[] = [];
  for (const ln of s["PROCESSES"] ?? []) {
    const p = ln.split("\t");
    // Require all 4 fields with a non-empty command name
    if (p.length >= 4 && p[3].trim()) {
      out.push({
        pid: sanitize(p[0]),
        cpu: sanitize(p[1]),
        mem: sanitize(p[2]),
        command: sanitize(p[3]),
        workingDir: p.length >= 5 ? sanitize(p[4]).replace(PROJECT_PREFIX, "") : "",
      });
    }
  }
  return out;
}

/** Strip ANSI escape codes and control characters from metrics output. */
function sanitize(s: string): string {
  return s
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")  // ANSI escape sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")  // control chars (keep \n \r \t)
    .trim();
}

function parseDocker(s: Record<string, string[]>): DockerContainer[] {
  // Build image lookup from DOCKER_PS section
  const images: Record<string, string> = {};
  for (const ln of s["DOCKER_PS"] ?? []) {
    const p = ln.split("\t");
    if (p.length >= 2) {
      images[p[0]] = p[1];
    }
  }

  const out: DockerContainer[] = [];
  for (const ln of s["DOCKER"] ?? []) {
    if (!ln.trim() || ln === "(none)") continue;
    const p = ln.split("\t");
    let name: string, cpu: string, memory: string;
    if (p.length >= 3) {
      [name, cpu, memory] = [p[0], p[1].trim(), p[2].trim()];
    } else {
      [name, cpu, memory] = [ln.trim(), "", ""];
    }
    const image = images[name] ?? "";
    const imageShort = image.includes("/") ? image.split("/").pop()! : image;
    // Extract service name (last part before -N replica suffix)
    const parts = name.split("-");
    const lastPart = parts[parts.length - 1];
    const service =
      parts.length >= 3 && /^\d+$/.test(lastPart)
        ? parts[parts.length - 2]
        : name;
    out.push({ name, cpu, memory, image: imageShort, project: service });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse section-delimited SSH output into a typed ComputeSnapshot.
 * Returns a zero-valued snapshot for empty / invalid input (never throws).
 */
export function parseSnapshot(stdout: string): ComputeSnapshot {
  if (!stdout || !stdout.trim()) return emptySnapshot();

  const s = splitSections(stdout);
  return {
    metrics: parseMetrics(s),
    sessions: parseSessions(s),
    processes: parseProcesses(s),
    docker: parseDocker(s),
  };
}

/**
 * Fetch fast metrics from an EC2 host via SSH.
 * Runs SSH_FAST_CMD and parses the output into a ComputeSnapshot.
 */
export async function fetchMetrics(key: string, ip: string): Promise<ComputeSnapshot> {
  const { stdout } = await sshExec(key, ip, SSH_FAST_CMD, { timeout: 15_000 });
  return parseSnapshot(stdout);
}

/**
 * Fetch fast metrics from an EC2 host via SSH (async / non-blocking).
 */
export async function fetchMetricsAsync(key: string, ip: string): Promise<ComputeSnapshot> {
  const { stdout } = await sshExecAsync(key, ip, SSH_FAST_CMD, { timeout: 15_000 });
  return parseSnapshot(stdout);
}

/**
 * Fetch docker metrics from an EC2 host via SSH.
 * Runs SSH_DOCKER_CMD and parses the output (only docker fields populated).
 */
export async function fetchDocker(key: string, ip: string): Promise<ComputeSnapshot> {
  const { stdout } = await sshExec(key, ip, SSH_DOCKER_CMD, { timeout: 30_000 });
  return parseSnapshot(stdout);
}

/**
 * Fetch docker metrics from an EC2 host via SSH (async / non-blocking).
 */
export async function fetchDockerAsync(key: string, ip: string): Promise<ComputeSnapshot> {
  const { stdout } = await sshExecAsync(key, ip, SSH_DOCKER_CMD, { timeout: 30_000 });
  return parseSnapshot(stdout);
}

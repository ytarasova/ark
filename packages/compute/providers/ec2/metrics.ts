/**
 * SSH-based metrics collection for EC2 hosts.
 * Ported from BigBox's dashboard/fetch.py + parse.py to TypeScript.
 */

import type {
  DockerContainer,
  HostMetrics,
  HostProcess,
  HostSession,
  HostSnapshot,
} from "../../types.js";
import { sshExec } from "./ssh.js";

// ---------------------------------------------------------------------------
// Internal sub-commands
// ---------------------------------------------------------------------------

const CLAUDE_CMD = [
  "for sess in $(tmux list-sessions -F '#{session_name}' 2>/dev/null); do",
  "  pid=$(tmux list-panes -t \"$sess\" -F '#{pane_pid}' 2>/dev/null | head -1);",
  "  cwd=$(tmux display-message -t \"$sess\" -p '#{pane_current_path}' 2>/dev/null);",
  "  cpu=$(ps -p $pid -o %cpu= 2>/dev/null | tr -d ' ');",
  "  mem=$(ps -p $pid -o %mem= 2>/dev/null | tr -d ' ');",
  "  cmd=$(ps -p $pid -o args= 2>/dev/null);",
  '  mode="interactive";',
  "  echo \"$cmd\" | grep -q 'dangerously' && mode=\"agentic\";",
  '  printf "%s\\t%s%%\\t%s%%\\t%s\\t%s\\n" "$sess" "$cpu" "$mem" "$cwd" "$mode";',
  "done",
].join(" ");

const PROCESSES_CMD = [
  "for pid in $(ps aux --sort=-%cpu",
  "| grep -vE 'sshd|grep|awk|ps aux|mpstat'",
  "| awk 'NR>1 && $3>0.1{print $2}' | head -8); do",
  "  cpu=$(ps -p $pid -o %cpu= 2>/dev/null | tr -d ' ');",
  "  mem=$(ps -p $pid -o %mem= 2>/dev/null | tr -d ' ');",
  "  cmd=$(ps -p $pid -o comm= 2>/dev/null);",
  "  cwd=$(readlink /proc/$pid/cwd 2>/dev/null | sed 's|/home/ubuntu/Projects/||');",
  '  printf "%s\\t%s%%\\t%s%%\\t%s\\t%s\\n" "$pid" "$cpu" "$mem" "$cmd" "$cwd";',
  "done",
].join(" ");

const NETWORK_CMD =
  "cat /proc/net/dev | awk '/eth0|ens/{printf \"%.1f %.1f\\n\", $2/1048576, $10/1048576}'";

const DOCKER_CMD =
  "docker stats --no-stream --format '{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}' 2>/dev/null || echo \"(none)\"";

const DOCKER_PS_CMD =
  "docker ps --format '{{.Names}}\\t{{.Image}}' 2>/dev/null";

// ---------------------------------------------------------------------------
// Exported SSH command strings
// ---------------------------------------------------------------------------

/** Single SSH command that outputs section-delimited fast metrics. */
export const SSH_FAST_CMD: string = [
  "echo \"=== CPU ===\" && mpstat 1 1 | tail -1 | awk '{printf \"%.1f\\n\", 100 - $NF}'",
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

const PROJECT_PREFIX = "/home/ubuntu/Projects/";

function emptyMetrics(): HostMetrics {
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

function emptySnapshot(): HostSnapshot {
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

function parseMetrics(s: Record<string, string[]>): HostMetrics {
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

function parseSessions(s: Record<string, string[]>): HostSession[] {
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

  const out: HostSession[] = [];
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

function parseProcesses(s: Record<string, string[]>): HostProcess[] {
  const out: HostProcess[] = [];
  for (const ln of s["PROCESSES"] ?? []) {
    const p = ln.split("\t");
    if (p.length >= 4) {
      out.push({
        pid: p[0],
        cpu: p[1],
        mem: p[2],
        command: p[3].trim(),
        workingDir: p.length >= 5 ? p[4].replace(PROJECT_PREFIX, "") : "",
      });
    } else if (ln.trim()) {
      out.push({ pid: "", cpu: "", mem: "", command: ln.trim(), workingDir: "" });
    }
  }
  return out;
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
 * Parse section-delimited SSH output into a typed HostSnapshot.
 * Returns a zero-valued snapshot for empty / invalid input (never throws).
 */
export function parseSnapshot(stdout: string): HostSnapshot {
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
 * Runs SSH_FAST_CMD and parses the output into a HostSnapshot.
 */
export function fetchMetrics(key: string, ip: string): HostSnapshot {
  const { stdout } = sshExec(key, ip, SSH_FAST_CMD, { timeout: 15_000 });
  return parseSnapshot(stdout);
}

/**
 * Fetch docker metrics from an EC2 host via SSH.
 * Runs SSH_DOCKER_CMD and parses the output (only docker fields populated).
 */
export function fetchDocker(key: string, ip: string): HostSnapshot {
  const { stdout } = sshExec(key, ip, SSH_DOCKER_CMD, { timeout: 30_000 });
  return parseSnapshot(stdout);
}

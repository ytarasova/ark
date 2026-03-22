/**
 * Local host metrics collection (macOS).
 *
 * Every shell command uses execFileSync (never exec) to avoid shell injection.
 */

import { execFileSync } from "child_process";
import type {
  HostSnapshot,
  HostMetrics,
  HostSession,
  HostProcess,
  DockerContainer,
} from "../../types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Run a command with execFileSync, return trimmed stdout or "" on failure. */
function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, {
      timeout: 10_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

// ── CPU ─────────────────────────────────────────────────────────────────────

function getCpu(): number {
  const out = run("top", ["-l", "1", "-n", "0", "-s", "0"]);
  // Line looks like: CPU usage: 5.26% user, 10.52% sys, 84.21% idle
  const match = out.match(
    /CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys/,
  );
  if (!match) return 0;
  return Math.round((parseFloat(match[1]) + parseFloat(match[2])) * 100) / 100;
}

// ── Memory ──────────────────────────────────────────────────────────────────

function getMemory(): { totalGb: number; usedGb: number; pct: number } {
  const totalBytes = parseInt(run("sysctl", ["-n", "hw.memsize"]), 10);
  if (!totalBytes || isNaN(totalBytes)) {
    return { totalGb: 0, usedGb: 0, pct: 0 };
  }

  const vmOut = run("vm_stat", []);
  if (!vmOut) return { totalGb: totalBytes / 1e9, usedGb: 0, pct: 0 };

  // Parse page size from the first line, e.g. "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
  const pageSizeMatch = vmOut.match(/page size of (\d+)/);
  const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 16384;

  const getPages = (label: string): number => {
    const re = new RegExp(`${label}:\\s+(\\d+)`);
    const m = vmOut.match(re);
    return m ? parseInt(m[1], 10) : 0;
  };

  const free = getPages("Pages free");
  const inactive = getPages("Pages inactive");
  const freeBytes = (free + inactive) * pageSize;
  const usedBytes = totalBytes - freeBytes;

  const totalGb = Math.round((totalBytes / (1024 ** 3)) * 100) / 100;
  const usedGb = Math.round((Math.max(0, usedBytes) / (1024 ** 3)) * 100) / 100;
  const pct = totalBytes > 0 ? Math.round((usedGb / totalGb) * 10000) / 100 : 0;

  return { totalGb, usedGb, pct };
}

// ── Disk ────────────────────────────────────────────────────────────────────

function getDisk(): number {
  const out = run("df", ["-h", "/"]);
  // Second line, capacity column is typically the 5th field, e.g. "85%"
  const lines = out.split("\n");
  if (lines.length < 2) return 0;
  const match = lines[1].match(/(\d+)%/);
  return match ? parseInt(match[1], 10) : 0;
}

// ── Uptime ──────────────────────────────────────────────────────────────────

function getUptime(): string {
  const out = run("uptime", []);
  if (!out) return "";
  // Clean up: strip the leading timestamp and "up " prefix, trim trailing load averages
  // e.g. " 14:23  up 3 days, 2:15, 4 users, load averages: 2.1 1.8 1.6"
  const match = out.match(/up\s+(.+?)(?:,\s*\d+\s+users?|,\s*load)/);
  if (match) return match[1].trim().replace(/,\s*$/, "");
  // Fallback: return everything after "up "
  const upIdx = out.indexOf("up ");
  return upIdx >= 0 ? out.slice(upIdx + 3).trim() : out;
}

// ── Tmux sessions ───────────────────────────────────────────────────────────

function getTmuxSessions(): HostSession[] {
  const listOut = run("tmux", ["list-sessions"]);
  if (!listOut) return [];

  const sessions: HostSession[] = [];

  for (const line of listOut.split("\n")) {
    if (!line.trim()) continue;
    // e.g. "my-session: 1 windows (created ...)"  or  "my-session: 1 windows (created ...) (attached)"
    const nameMatch = line.match(/^([^:]+):/);
    if (!nameMatch) continue;

    const name = nameMatch[1].trim();
    const attached = line.includes("(attached)");
    const status = attached ? "attached" : "detached";

    // Get pane PID for this session
    const panePid = run("tmux", [
      "list-panes",
      "-t",
      name,
      "-F",
      "#{pane_pid}",
    ]);

    let cpu = 0;
    let mem = 0;
    let mode = "unknown";
    let projectPath = "";

    if (panePid) {
      const firstPid = panePid.split("\n")[0].trim();
      if (firstPid) {
        // Get child processes via pgrep (macOS ps lacks --ppid)
        const childrenOut = run("pgrep", ["-P", firstPid]);
        const childPids = childrenOut
          .split("\n")
          .filter((p) => p.trim())
          .map((p) => p.trim());

        for (const cpid of childPids) {
          const info = run("ps", ["-p", cpid, "-o", "pcpu,pmem,args"]);
          if (info.toLowerCase().includes("claude")) {
            const statsMatch = info.match(
              /\s*([\d.]+)\s+([\d.]+)\s+(.+)/m,
            );
            if (statsMatch) {
              cpu = parseFloat(statsMatch[1]) || 0;
              mem = parseFloat(statsMatch[2]) || 0;
              const args = statsMatch[3];
              mode = args.includes("dangerously") ? "development" : "normal";
            }
            break;
          }
        }

        // Try to get working directory from pane
        const paneDir = run("tmux", [
          "display-message",
          "-t",
          name,
          "-p",
          "#{pane_current_path}",
        ]);
        if (paneDir) projectPath = paneDir;
      }
    }

    sessions.push({ name, status, mode, projectPath, cpu, mem });
  }

  return sessions;
}

// ── Top processes ───────────────────────────────────────────────────────────

function getTopProcesses(): HostProcess[] {
  const out = run("ps", ["aux"]);
  if (!out) return [];

  const lines = out.split("\n");
  if (lines.length < 2) return [];

  const procs: HostProcess[] = [];

  // Skip header (first line)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Fields: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND...
    const parts = line.split(/\s+/);
    if (parts.length < 11) continue;

    const cpuVal = parseFloat(parts[2]);
    if (cpuVal <= 0.1) continue;

    const pid = parts[1];
    const cpuStr = parts[2];
    const memStr = parts[3];
    const command = parts.slice(10).join(" ");

    procs.push({ pid, cpu: cpuStr, mem: memStr, command, workingDir: "" });
  }

  // Sort by CPU descending
  procs.sort((a, b) => parseFloat(b.cpu) - parseFloat(a.cpu));

  return procs.slice(0, 8);
}

// ── Docker containers ───────────────────────────────────────────────────────

function getDockerContainers(): DockerContainer[] {
  const statsOut = run("docker", [
    "stats",
    "--no-stream",
    "--format",
    "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}",
  ]);
  if (!statsOut) return [];

  // Get image mapping from docker ps
  const psOut = run("docker", [
    "ps",
    "--format",
    "{{.Names}}\t{{.Image}}\t{{.Labels}}",
  ]);
  const imageMap = new Map<string, { image: string; project: string }>();
  if (psOut) {
    for (const line of psOut.split("\n")) {
      const parts = line.split("\t");
      if (parts.length >= 2) {
        const name = parts[0].trim();
        const image = parts[1].trim();
        // Try to extract compose project from labels
        const labels = parts[2] || "";
        const projectMatch = labels.match(
          /com\.docker\.compose\.project=([^,]+)/,
        );
        const project = projectMatch ? projectMatch[1] : "";
        imageMap.set(name, { image, project });
      }
    }
  }

  const containers: DockerContainer[] = [];
  for (const line of statsOut.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;

    const name = parts[0].trim();
    const cpu = parts[1].trim();
    const memory = parts[2].trim();
    const info = imageMap.get(name) || { image: "", project: "" };

    containers.push({
      name,
      cpu,
      memory,
      image: info.image,
      project: info.project,
    });
  }

  return containers;
}

// ── Main ────────────────────────────────────────────────────────────────────

export async function collectLocalMetrics(): Promise<HostSnapshot> {
  const mem = getMemory();

  const metrics: HostMetrics = {
    cpu: getCpu(),
    memUsedGb: mem.usedGb,
    memTotalGb: mem.totalGb,
    memPct: mem.pct,
    diskPct: getDisk(),
    netRxMb: 0,
    netTxMb: 0,
    uptime: getUptime(),
    idleTicks: 0,
  };

  const sessions = getTmuxSessions();
  const processes = getTopProcesses();
  const docker = getDockerContainers();

  return { metrics, sessions, processes, docker };
}

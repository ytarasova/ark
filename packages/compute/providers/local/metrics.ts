/**
 * Local host metrics collection (macOS).
 *
 * Every shell command uses async execFile (never exec) to avoid shell injection.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type {
  ComputeSnapshot,
  ComputeMetrics,
  ComputeSession,
  ComputeProcess,
  DockerContainer,
} from "../../types.js";

const execFileAsync = promisify(execFile);

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Run a command asynchronously - non-blocking */
async function run(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: 10_000,
      encoding: "utf-8",
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

// ── CPU ─────────────────────────────────────────────────────────────────────

function parseCpuOutput(out: string): number {
  const match = out.match(
    /CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys/,
  );
  if (!match) return 0;
  return Math.round((parseFloat(match[1]) + parseFloat(match[2])) * 100) / 100;
}

async function getCpu(): Promise<number> {
  return parseCpuOutput(await run("top", ["-l", "1", "-n", "0", "-s", "0"]));
}

// ── Memory ──────────────────────────────────────────────────────────────────

function parseMemoryOutput(totalStr: string, vmOut: string): { totalGb: number; usedGb: number; pct: number } {
  const totalBytes = parseInt(totalStr, 10);
  if (!totalBytes || isNaN(totalBytes)) {
    return { totalGb: 0, usedGb: 0, pct: 0 };
  }

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

async function getMemory(): Promise<{ totalGb: number; usedGb: number; pct: number }> {
  const [totalStr, vmOut] = await Promise.all([
    run("sysctl", ["-n", "hw.memsize"]),
    run("vm_stat", []),
  ]);
  return parseMemoryOutput(totalStr, vmOut);
}

// ── Disk ────────────────────────────────────────────────────────────────────

function parseDiskOutput(out: string): number {
  const lines = out.split("\n");
  if (lines.length < 2) return 0;
  const match = lines[1].match(/(\d+)%/);
  return match ? parseInt(match[1], 10) : 0;
}

async function getDisk(): Promise<number> {
  return parseDiskOutput(await run("df", ["-h", "/"]));
}

// ── Uptime ──────────────────────────────────────────────────────────────────

function parseUptimeOutput(out: string): string {
  if (!out) return "";
  // Clean up: strip the leading timestamp and "up " prefix, trim trailing load averages
  // e.g. " 14:23  up 3 days, 2:15, 4 users, load averages: 2.1 1.8 1.6"
  const match = out.match(/up\s+(.+?)(?:,\s*\d+\s+users?|,\s*load)/);
  if (match) return match[1].trim().replace(/,\s*$/, "");
  // Fallback: return everything after "up "
  const upIdx = out.indexOf("up ");
  return upIdx >= 0 ? out.slice(upIdx + 3).trim() : out;
}

async function getUptime(): Promise<string> {
  return parseUptimeOutput(await run("uptime", []));
}

// ── Tmux sessions ───────────────────────────────────────────────────────────

async function getTmuxSessions(): Promise<ComputeSession[]> {
  const listOut = await run("tmux", ["list-sessions"]);
  if (!listOut) return [];

  const sessions: ComputeSession[] = [];

  for (const line of listOut.split("\n")) {
    if (!line.trim()) continue;
    const nameMatch = line.match(/^([^:]+):/);
    if (!nameMatch) continue;

    const name = nameMatch[1].trim();
    const attached = line.includes("(attached)");
    const status = attached ? "attached" : "detached";

    const panePid = await run("tmux", [
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
        const childrenOut = await run("pgrep", ["-P", firstPid]);
        const childPids = childrenOut
          .split("\n")
          .filter((p) => p.trim())
          .map((p) => p.trim());

        for (const cpid of childPids) {
          const info = await run("ps", ["-p", cpid, "-o", "pcpu,pmem,args"]);
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

        const paneDir = await run("tmux", [
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

function parseTopProcesses(out: string): ComputeProcess[] {
  if (!out) return [];

  const lines = out.split("\n");
  if (lines.length < 2) return [];

  const procs: ComputeProcess[] = [];

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

async function getTopProcesses(): Promise<ComputeProcess[]> {
  return parseTopProcesses(await run("ps", ["aux"]));
}

// ── Docker containers ───────────────────────────────────────────────────────

function parseDockerContainers(statsOut: string, psOut: string): DockerContainer[] {
  if (!statsOut) return [];

  const imageMap = new Map<string, { image: string; project: string }>();
  if (psOut) {
    for (const line of psOut.split("\n")) {
      const parts = line.split("\t");
      if (parts.length >= 2) {
        const name = parts[0].trim();
        const image = parts[1].trim();
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

async function getDockerContainers(): Promise<DockerContainer[]> {
  const [statsOut, psOut] = await Promise.all([
    run("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}",
    ]),
    run("docker", [
      "ps",
      "--format",
      "{{.Names}}\t{{.Image}}\t{{.Labels}}",
    ]),
  ]);
  return parseDockerContainers(statsOut, psOut);
}

// ── Main ────────────────────────────────────────────────────────────────────

export async function collectLocalMetrics(): Promise<ComputeSnapshot> {
  // Run all async collectors in parallel - non-blocking
  const [cpu, mem, diskPct, uptime, sessions, processes, docker] = await Promise.all([
    getCpu(),
    getMemory(),
    getDisk(),
    getUptime(),
    getTmuxSessions(),
    getTopProcesses(),
    getDockerContainers(),
  ]);

  const metrics: ComputeMetrics = {
    cpu,
    memUsedGb: mem.usedGb,
    memTotalGb: mem.totalGb,
    memPct: mem.pct,
    diskPct,
    netRxMb: 0,
    netTxMb: 0,
    uptime,
    idleTicks: 0,
  };

  return { metrics, sessions, processes, docker };
}

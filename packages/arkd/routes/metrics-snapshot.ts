/**
 * /metrics, /snapshot, /ports/probe routes.
 *
 * Extracted from server.ts; behavior unchanged. Each collector shells
 * out via spawnRead() with its own short bounded timeouts; the parent
 * handler relies on the server's idleTimeout for the overall budget.
 */

import { platform, uptime, totalmem, freemem, cpus } from "os";
import type {
  MetricsRes,
  ProbePortsReq,
  ProbePortsRes,
  SnapshotRes,
  SnapshotMetrics,
  SnapshotSession,
  SnapshotProcess,
  SnapshotContainer,
} from "../types.js";
import { logDebug, logInfo } from "../../core/observability/structured-log.js";
import { json, readStream, spawnRead, type BunLike, type RouteCtx } from "../internal.js";

// ── Metrics ──────────────────────────────────────────────────────────────────

async function collectMetrics(): Promise<MetricsRes> {
  const Bun = (globalThis as unknown as { Bun: BunLike }).Bun;
  const totalGb = totalmem() / 1024 ** 3;
  const freeGb = freemem() / 1024 ** 3;
  const usedGb = totalGb - freeGb;

  // CPU: average across cores (1s sample would block, use instant load)
  const cores = cpus();
  let totalIdle = 0,
    totalTick = 0;
  for (const c of cores) {
    const times = c.times as Record<string, number>;
    for (const type in times) {
      totalTick += times[type];
    }
    totalIdle += c.times.idle;
  }
  const cpu = Math.round((1 - totalIdle / totalTick) * 100);

  // Disk: use df on root
  let diskPct = 0;
  try {
    const proc = Bun.spawn({ cmd: ["df", "-P", "/"], stdout: "pipe", stderr: "pipe" });
    const out = await readStream(proc.stdout);
    await proc.exited;
    const lines = out.trim().split("\n");
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      diskPct = parseInt(parts[4]?.replace("%", "") ?? "0", 10);
    }
  } catch {
    logDebug("compute", "disk usage command may not be available");
  }

  // Uptime
  const uptimeSec = uptime();
  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  const uptimeStr = days > 0 ? `${days}d ${hours}h` : `${hours}h`;

  return {
    cpu,
    memUsedGb: Math.round(usedGb * 100) / 100,
    memTotalGb: Math.round(totalGb * 100) / 100,
    memPct: Math.round((usedGb / totalGb) * 100),
    diskPct,
    uptime: uptimeStr,
  };
}

// ── System snapshot ──────────────────────────────────────────────────────────

async function collectSnapshot(): Promise<SnapshotRes> {
  const [metrics, sessions, processes, docker] = await Promise.all([
    collectSnapshotMetrics(),
    collectTmuxSessions(),
    collectTopProcesses(),
    collectDockerContainers(),
  ]);
  return { metrics, sessions, processes, docker };
}

async function collectSnapshotMetrics(): Promise<SnapshotMetrics> {
  const isMac = platform() === "darwin";
  const [cpuVal, mem, diskPct, uptimeStr] = await Promise.all([
    isMac ? getMacCpu() : getLinuxCpu(),
    isMac ? getMacMemory() : getNodeMemory(),
    getDiskPct(),
    getUptimeStr(),
  ]);
  return {
    cpu: cpuVal,
    memUsedGb: mem.usedGb,
    memTotalGb: mem.totalGb,
    memPct: mem.pct,
    diskPct,
    netRxMb: 0,
    netTxMb: 0,
    uptime: uptimeStr,
    idleTicks: 0,
  };
}

async function getMacCpu(): Promise<number> {
  const out = await spawnRead(["top", "-l", "1", "-n", "0", "-s", "0"]);
  const match = out.match(/CPU usage:\s*([\d.]+)%\s*user,\s*([\d.]+)%\s*sys/);
  if (!match) return 0;
  return Math.round((parseFloat(match[1]) + parseFloat(match[2])) * 100) / 100;
}

async function getLinuxCpu(): Promise<number> {
  const cores = cpus();
  let totalIdle = 0,
    totalTick = 0;
  for (const c of cores) {
    const times = c.times as Record<string, number>;
    for (const type in times) totalTick += times[type];
    totalIdle += c.times.idle;
  }
  return Math.round((1 - totalIdle / totalTick) * 100);
}

async function getMacMemory(): Promise<{ totalGb: number; usedGb: number; pct: number }> {
  const [totalStr, vmOut] = await Promise.all([spawnRead(["sysctl", "-n", "hw.memsize"]), spawnRead(["vm_stat"])]);
  const totalBytes = parseInt(totalStr, 10);
  if (!totalBytes || isNaN(totalBytes)) return { totalGb: 0, usedGb: 0, pct: 0 };
  if (!vmOut) return { totalGb: totalBytes / 1e9, usedGb: 0, pct: 0 };

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
  const totalGb = Math.round((totalBytes / 1024 ** 3) * 100) / 100;
  const usedGb = Math.round((Math.max(0, usedBytes) / 1024 ** 3) * 100) / 100;
  const pct = totalBytes > 0 ? Math.round((usedGb / totalGb) * 10000) / 100 : 0;
  return { totalGb, usedGb, pct };
}

function getNodeMemory(): Promise<{ totalGb: number; usedGb: number; pct: number }> {
  const totalGb = Math.round((totalmem() / 1024 ** 3) * 100) / 100;
  const freeGb = freemem() / 1024 ** 3;
  const usedGb = Math.round((totalGb - freeGb) * 100) / 100;
  const pct = Math.round((usedGb / totalGb) * 100);
  return Promise.resolve({ totalGb, usedGb, pct });
}

async function getDiskPct(): Promise<number> {
  const out = await spawnRead(["df", "-P", "/"]);
  const lines = out.trim().split("\n");
  if (lines.length >= 2) {
    const parts = lines[1].split(/\s+/);
    return parseInt(parts[4]?.replace("%", "") ?? "0", 10);
  }
  return 0;
}

async function getUptimeStr(): Promise<string> {
  if (platform() === "darwin") {
    const out = await spawnRead(["uptime"]);
    const match = out.match(/up\s+(.+?)(?:,\s*\d+\s+users?|,\s*load)/);
    if (match) return match[1].trim().replace(/,\s*$/, "");
    const upIdx = out.indexOf("up ");
    return upIdx >= 0 ? out.slice(upIdx + 3).trim() : out;
  }
  const sec = uptime();
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

async function collectTmuxSessions(): Promise<SnapshotSession[]> {
  const listOut = await spawnRead(["tmux", "list-sessions"]);
  if (!listOut) return [];

  const sessions: SnapshotSession[] = [];
  for (const line of listOut.split("\n")) {
    if (!line.trim()) continue;
    const nameMatch = line.match(/^([^:]+):/);
    if (!nameMatch) continue;

    const name = nameMatch[1].trim();
    const attached = line.includes("(attached)");

    const panePid = await spawnRead(["tmux", "list-panes", "-t", name, "-F", "#{pane_pid}"]);
    let cpu = 0,
      mem = 0,
      mode = "unknown",
      projectPath = "";

    if (panePid) {
      const firstPid = panePid.split("\n")[0].trim();
      if (firstPid) {
        const childrenOut = await spawnRead(["pgrep", "-P", firstPid]);
        const childPids = childrenOut.split("\n").filter((p) => p.trim());
        for (const cpid of childPids) {
          const info = await spawnRead(["ps", "-p", cpid, "-o", "pcpu,pmem,args"]);
          if (info.toLowerCase().includes("claude")) {
            const m = info.match(/\s*([\d.]+)\s+([\d.]+)\s+(.+)/m);
            if (m) {
              cpu = parseFloat(m[1]) || 0;
              mem = parseFloat(m[2]) || 0;
              mode = m[3].includes("dangerously") ? "development" : "normal";
            }
            break;
          }
        }
        const paneDir = await spawnRead(["tmux", "display-message", "-t", name, "-p", "#{pane_current_path}"]);
        if (paneDir) projectPath = paneDir;
      }
    }

    sessions.push({ name, status: attached ? "attached" : "detached", mode, projectPath, cpu, mem });
  }
  return sessions;
}

async function collectTopProcesses(): Promise<SnapshotProcess[]> {
  const out = await spawnRead(["ps", "aux"]);
  if (!out) return [];
  const lines = out.split("\n");
  if (lines.length < 2) return [];

  const procs: SnapshotProcess[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 11) continue;
    const cpuVal = parseFloat(parts[2]);
    if (cpuVal <= 0.1) continue;
    procs.push({ pid: parts[1], cpu: parts[2], mem: parts[3], command: parts.slice(10).join(" "), workingDir: "" });
  }
  procs.sort((a, b) => parseFloat(b.cpu) - parseFloat(a.cpu));
  return procs.slice(0, 8);
}

async function collectDockerContainers(): Promise<SnapshotContainer[]> {
  const [statsOut, psOut] = await Promise.all([
    spawnRead(["docker", "stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"]),
    spawnRead(["docker", "ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Labels}}"]),
  ]);
  if (!statsOut) return [];

  const imageMap = new Map<string, { image: string; project: string }>();
  if (psOut) {
    for (const line of psOut.split("\n")) {
      const parts = line.split("\t");
      if (parts.length >= 2) {
        const name = parts[0].trim();
        const image = parts[1].trim();
        const labels = parts[2] || "";
        const projectMatch = labels.match(/com\.docker\.compose\.project=([^,]+)/);
        imageMap.set(name, { image, project: projectMatch ? projectMatch[1] : "" });
      }
    }
  }

  const containers: SnapshotContainer[] = [];
  for (const line of statsOut.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const name = parts[0].trim();
    const info = imageMap.get(name) || { image: "", project: "" };
    containers.push({ name, cpu: parts[1].trim(), memory: parts[2].trim(), image: info.image, project: info.project });
  }
  return containers;
}

// ── Port probing ─────────────────────────────────────────────────────────────

async function probePorts(req: ProbePortsReq): Promise<ProbePortsRes> {
  const Bun = (globalThis as unknown as { Bun: BunLike }).Bun;
  const results = await Promise.all(
    req.ports.map(async (port) => {
      let listening = false;
      try {
        const cmd =
          platform() === "darwin" ? ["lsof", "-i", `:${port}`, "-sTCP:LISTEN"] : ["ss", "-tlnH", `sport = :${port}`];
        const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
        const out = await readStream(proc.stdout);
        await proc.exited;
        listening = out.trim().length > 0;
      } catch {
        logInfo("compute", "port check command may fail");
      }
      return { port, listening };
    }),
  );
  return { results };
}

export async function handleMetricsSnapshotRoutes(
  req: Request,
  path: string,
  _ctx: RouteCtx,
): Promise<Response | null> {
  if (req.method === "GET" && path === "/metrics") {
    return json(await collectMetrics());
  }
  if (req.method === "GET" && path === "/snapshot") {
    return json(await collectSnapshot());
  }
  if (req.method === "POST" && path === "/ports/probe") {
    const body = (await req.json()) as ProbePortsReq;
    return json(await probePorts(body));
  }
  return null;
}

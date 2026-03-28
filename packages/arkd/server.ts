/**
 * ArkD HTTP server — runs on every compute target.
 *
 * Provides file ops, process execution, agent lifecycle (tmux),
 * system metrics, and port probing over a typed JSON-over-HTTP API.
 */

declare const Bun: {
  serve(options: {
    port: number;
    hostname: string;
    fetch(req: Request): Promise<Response> | Response;
  }): { stop(): void };
  spawn(opts: {
    cmd: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: "pipe" | "ignore";
    stdout?: "pipe";
    stderr?: "pipe";
    timeout?: number;
  }): {
    pid: number;
    exitCode: Promise<number>;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    stdin: WritableStream<Uint8Array>;
    kill(): void;
    exited: Promise<number>;
  };
};

import { readFile, writeFile, stat, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { hostname, platform, uptime, totalmem, freemem, cpus } from "os";
import type {
  ReadFileReq, ReadFileRes,
  WriteFileReq, WriteFileRes,
  ListDirReq, ListDirRes, DirEntry,
  StatReq, StatRes,
  MkdirReq, MkdirRes,
  ExecReq, ExecRes,
  AgentLaunchReq, AgentLaunchRes,
  AgentKillReq, AgentKillRes,
  AgentStatusReq, AgentStatusRes,
  AgentCaptureReq, AgentCaptureRes,
  MetricsRes,
  ProbePortsReq, ProbePortsRes,
  HealthRes,
} from "./types.js";

const VERSION = "0.1.0";
const DEFAULT_PORT = 19300;

export function startArkd(port = DEFAULT_PORT, opts?: { quiet?: boolean }): { stop(): void } {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      try {
        // ── Health ─────────────────────────────────────────────────────
        if (req.method === "GET" && path === "/health") {
          return json<HealthRes>({
            status: "ok",
            version: VERSION,
            hostname: hostname(),
            platform: platform(),
          });
        }

        // ── Metrics ───────────────────────────────────────────────────
        if (req.method === "GET" && path === "/metrics") {
          return json(await collectMetrics());
        }

        // ── File: read ────────────────────────────────────────────────
        if (req.method === "POST" && path === "/file/read") {
          const body = await req.json() as ReadFileReq;
          try {
            const content = await readFile(body.path, "utf-8");
            return json<ReadFileRes>({ content, size: Buffer.byteLength(content) });
          } catch (e: any) {
            if (e.code === "ENOENT") return json({ error: "file not found", code: "ENOENT" }, 404);
            throw e;
          }
        }

        // ── File: write ───────────────────────────────────────────────
        if (req.method === "POST" && path === "/file/write") {
          const body = await req.json() as WriteFileReq;
          await writeFile(body.path, body.content, body.mode ? { mode: body.mode } : undefined);
          return json<WriteFileRes>({ ok: true, bytesWritten: Buffer.byteLength(body.content) });
        }

        // ── File: stat ────────────────────────────────────────────────
        if (req.method === "POST" && path === "/file/stat") {
          const body = await req.json() as StatReq;
          try {
            const s = await stat(body.path);
            const type = s.isFile() ? "file" : s.isDirectory() ? "dir" : "symlink";
            return json<StatRes>({
              exists: true,
              type,
              size: s.size,
              mtime: s.mtime.toISOString(),
            });
          } catch (e: any) {
            if (e.code === "ENOENT") return json<StatRes>({ exists: false });
            throw e;
          }
        }

        // ── File: mkdir ───────────────────────────────────────────────
        if (req.method === "POST" && path === "/file/mkdir") {
          const body = await req.json() as MkdirReq;
          await mkdir(body.path, { recursive: body.recursive ?? true });
          return json<MkdirRes>({ ok: true });
        }

        // ── File: list ────────────────────────────────────────────────
        if (req.method === "POST" && path === "/file/list") {
          const body = await req.json() as ListDirReq;
          const entries = await listDirectory(body.path, body.recursive);
          return json<ListDirRes>({ entries });
        }

        // ── Exec ──────────────────────────────────────────────────────
        if (req.method === "POST" && path === "/exec") {
          const body = await req.json() as ExecReq;
          const result = await runExec(body);
          return json(result);
        }

        // ── Agent: launch ─────────────────────────────────────────────
        if (req.method === "POST" && path === "/agent/launch") {
          const body = await req.json() as AgentLaunchReq;
          const result = await agentLaunch(body);
          return json(result);
        }

        // ── Agent: kill ───────────────────────────────────────────────
        if (req.method === "POST" && path === "/agent/kill") {
          const body = await req.json() as AgentKillReq;
          const result = await agentKill(body);
          return json(result);
        }

        // ── Agent: status ─────────────────────────────────────────────
        if (req.method === "POST" && path === "/agent/status") {
          const body = await req.json() as AgentStatusReq;
          const result = await agentStatus(body);
          return json(result);
        }

        // ── Agent: capture ────────────────────────────────────────────
        if (req.method === "POST" && path === "/agent/capture") {
          const body = await req.json() as AgentCaptureReq;
          const result = await agentCapture(body);
          return json(result);
        }

        // ── Ports: probe ──────────────────────────────────────────────
        if (req.method === "POST" && path === "/ports/probe") {
          const body = await req.json() as ProbePortsReq;
          const result = await probePorts(body);
          return json(result);
        }

        return new Response("Not found", { status: 404 });
      } catch (e: any) {
        if (e instanceof SyntaxError) {
          return json({ error: "invalid JSON" }, 400);
        }
        return json({ error: String(e.message ?? e) }, 500);
      }
    },
  });

  if (!opts?.quiet) console.log(`arkd listening on localhost:${port}`);

  return {
    stop() { server.stop(); },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function listDirectory(dirPath: string, recursive?: boolean): Promise<DirEntry[]> {
  const entries: DirEntry[] = [];
  const items = await readdir(dirPath, { withFileTypes: true });
  for (const item of items) {
    const fullPath = join(dirPath, item.name);
    const type = item.isFile() ? "file" as const
      : item.isDirectory() ? "dir" as const
      : "symlink" as const;

    let size = 0;
    if (item.isFile()) {
      try { size = (await stat(fullPath)).size; } catch {}
    }

    entries.push({ name: item.name, path: fullPath, type, size });

    if (recursive && item.isDirectory()) {
      const sub = await listDirectory(fullPath, true);
      entries.push(...sub);
    }
  }
  return entries;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  return buf.toString("utf-8");
}

async function runExec(req: ExecReq): Promise<ExecRes> {
  const cmd = [req.command, ...(req.args ?? [])];
  const timeout = req.timeout ?? 30_000;

  const proc = Bun.spawn({
    cmd,
    cwd: req.cwd,
    env: req.env ? { ...process.env, ...req.env } : undefined,
    stdin: req.stdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (req.stdin && proc.stdin) {
    // Bun's stdin is a FileSink, not a WritableStream
    const sink = proc.stdin as any;
    sink.write(req.stdin);
    sink.end();
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout);

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited,
  ]);

  clearTimeout(timer);

  return { exitCode, stdout, stderr, timedOut };
}

// ── Agent (tmux) operations ──────────────────────────────────────────────────

async function agentLaunch(req: AgentLaunchReq): Promise<AgentLaunchRes> {
  // Write launcher script to a temp file
  const scriptPath = `/tmp/arkd-launcher-${req.sessionName}.sh`;
  await writeFile(scriptPath, req.script, { mode: 0o755 });

  const proc = Bun.spawn({
    cmd: ["tmux", "new-session", "-d", "-s", req.sessionName, "-c", req.workdir, `bash ${scriptPath}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;

  return { ok: true };
}

async function agentKill(req: AgentKillReq): Promise<AgentKillRes> {
  const wasRunning = await isTmuxRunning(req.sessionName);
  if (wasRunning) {
    const proc = Bun.spawn({
      cmd: ["tmux", "kill-session", "-t", req.sessionName],
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  }
  return { ok: true, wasRunning };
}

async function agentStatus(req: AgentStatusReq): Promise<AgentStatusRes> {
  const running = await isTmuxRunning(req.sessionName);
  return { running };
}

async function agentCapture(req: AgentCaptureReq): Promise<AgentCaptureRes> {
  const lines = req.lines ?? 100;
  const proc = Bun.spawn({
    cmd: ["tmux", "capture-pane", "-t", req.sessionName, "-p", "-S", `-${lines}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await readStream(proc.stdout);
  await proc.exited;
  return { output: output.trimEnd() };
}

async function isTmuxRunning(sessionName: string): Promise<boolean> {
  const proc = Bun.spawn({
    cmd: ["tmux", "has-session", "-t", sessionName],
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return code === 0;
}

// ── Metrics ──────────────────────────────────────────────────────────────────

async function collectMetrics(): Promise<MetricsRes> {
  const totalGb = totalmem() / (1024 ** 3);
  const freeGb = freemem() / (1024 ** 3);
  const usedGb = totalGb - freeGb;

  // CPU: average across cores (1s sample would block, use instant load)
  const cores = cpus();
  let totalIdle = 0, totalTick = 0;
  for (const c of cores) {
    for (const type in c.times) {
      totalTick += (c.times as any)[type];
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
  } catch {}

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

// ── Port probing ─────────────────────────────────────────────────────────────

async function probePorts(req: ProbePortsReq): Promise<ProbePortsRes> {
  const results = await Promise.all(
    req.ports.map(async (port) => {
      let listening = false;
      try {
        const cmd = platform() === "darwin"
          ? ["lsof", "-i", `:${port}`, "-sTCP:LISTEN"]
          : ["ss", "-tlnH", `sport = :${port}`];
        const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
        const out = await readStream(proc.stdout);
        await proc.exited;
        listening = out.trim().length > 0;
      } catch {}
      return { port, listening };
    })
  );
  return { results };
}

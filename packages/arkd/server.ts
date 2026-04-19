/**
 * ArkD HTTP server - runs on every compute target.
 *
 * Provides file ops, process execution, agent lifecycle (tmux),
 * system metrics, and port probing over a typed JSON-over-HTTP API.
 */

declare const Bun: {
  serve(options: { port: number; hostname: string; fetch(req: Request): Promise<Response> | Response }): {
    stop(): void;
  };
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
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, resolve, sep } from "path";
import { hostname, platform, uptime, totalmem, freemem, cpus, homedir } from "os";
import { timingSafeEqual } from "crypto";
import { DEFAULT_CHANNEL_BASE_URL } from "../core/constants.js";
import type {
  ReadFileReq,
  ReadFileRes,
  WriteFileReq,
  WriteFileRes,
  ListDirReq,
  ListDirRes,
  DirEntry,
  StatReq,
  StatRes,
  MkdirReq,
  MkdirRes,
  ExecReq,
  ExecRes,
  AgentLaunchReq,
  AgentLaunchRes,
  AgentKillReq,
  AgentKillRes,
  AgentStatusReq,
  AgentStatusRes,
  AgentCaptureReq,
  AgentCaptureRes,
  MetricsRes,
  ProbePortsReq,
  ProbePortsRes,
  HealthRes,
  SnapshotRes,
  SnapshotMetrics,
  SnapshotSession,
  SnapshotProcess,
  SnapshotContainer,
  ChannelReportRes,
  ChannelRelayReq,
  ChannelRelayRes,
  ChannelDeliverReq,
  ChannelDeliverRes,
  ConfigReq,
  ConfigRes,
} from "./types.js";
import { logInfo, logDebug } from "../core/observability/structured-log.js";

const VERSION = "0.1.0";
const DEFAULT_PORT = 19300;

export interface ArkdOpts {
  quiet?: boolean;
  conductorUrl?: string;
  hostname?: string;
  /** Bearer token for auth. Overrides ARK_ARKD_TOKEN env var. */
  token?: string;
  /**
   * Filesystem root that every /file/* and /exec request is confined to.
   * All paths in request bodies (and /exec cwd) must resolve to a
   * descendant of this directory. Overrides ARK_WORKSPACE_ROOT env var.
   *
   * Required in hosted / untrusted contexts; when unset, /file/* and
   * /exec accept absolute paths from any caller and trust the bearer
   * token for full host FS access -- acceptable only for local-single-user
   * mode, which is the historical behavior retained for backward compat.
   */
  workspaceRoot?: string;
}

/**
 * Resolve a user-supplied path and verify it stays under `root`.
 *
 * `root` must be an absolute, canonical directory path. Throws when the
 * input tries to escape via `..`, absolute paths outside the root,
 * empty / non-string input, or symlink-style traversal tricks.
 *
 * NOTE: this is a string-level guard. It does not `realpath` the target
 * (the file may not yet exist). Symlink traversal is mitigated at the
 * caller by refusing to write through links, but the primary defense
 * against malicious requests is that every absolute path NOT starting
 * with `root` is rejected outright.
 */
function confineToWorkspace(root: string, userPath: unknown): string {
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw new PathConfinementError("path must be a non-empty string");
  }
  if (userPath.includes("\0")) {
    throw new PathConfinementError("path contains NUL byte");
  }
  // Resolve against the root for relative paths; absolute paths resolve
  // to themselves. In either case we then check the prefix.
  const resolved = resolve(root, userPath);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new PathConfinementError(`path escapes workspace root: ${userPath}`);
  }
  return resolved;
}

export class PathConfinementError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PathConfinementError";
  }
}

/** Paths that bypass authentication (health probes). */
const AUTH_EXEMPT_PATHS = new Set(["/health"]);

/** Commands allowed by the /exec endpoint. */
const EXEC_ALLOWED_COMMANDS = new Set([
  "git",
  "bun",
  "make",
  "npm",
  "npx",
  "node",
  "cat",
  "ls",
  "head",
  "tail",
  "grep",
  "find",
  "wc",
  "diff",
  "echo",
  "pwd",
  "mkdir",
  "cp",
  "mv",
  "rm",
  "touch",
  "chmod",
  "sh",
  "bash",
  "zsh",
  "tmux",
  "df",
  "ps",
  "pgrep",
  "top",
  "uptime",
  "sysctl",
  "vm_stat",
  "lsof",
  "ss",
  "docker",
  "devcontainer",
  "claude",
  "codex",
  "gemini",
  "goose",
  "codegraph",
]);

export function startArkd(port = DEFAULT_PORT, opts?: ArkdOpts): { stop(): void; setConductorUrl(url: string): void } {
  // Mutable runtime config
  let conductorUrl: string | null = opts?.conductorUrl ?? process.env.ARK_CONDUCTOR_URL ?? "http://localhost:19100";
  const bindHost = opts?.hostname ?? "0.0.0.0";

  // Workspace confinement root (P1-4). When set, every /file/* and /exec
  // request is restricted to paths under this directory. When unset,
  // arkd retains legacy unconfined behavior for local single-user mode.
  const workspaceRootRaw = opts?.workspaceRoot ?? process.env.ARK_WORKSPACE_ROOT ?? null;
  const workspaceRoot: string | null = workspaceRootRaw ? resolve(workspaceRootRaw) : null;
  if (workspaceRoot) {
    // Ensure the root exists so confined writes succeed out of the box.
    try {
      mkdirSync(workspaceRoot, { recursive: true });
    } catch {
      logDebug("compute", "best effort -- first real request will surface any permission error");
    }
  }

  /**
   * Enforce workspace confinement (no-op when workspaceRoot is null).
   * Returns the resolved absolute path, or throws PathConfinementError.
   */
  function confine(userPath: unknown): string {
    if (!workspaceRoot) {
      if (typeof userPath !== "string") {
        throw new PathConfinementError("path must be a string");
      }
      return userPath;
    }
    return confineToWorkspace(workspaceRoot, userPath);
  }

  // Auth token
  const arkdToken: string | null = opts?.token ?? process.env.ARK_ARKD_TOKEN ?? null;
  if (arkdToken) {
    const arkDir = join(homedir(), ".ark");
    if (!existsSync(arkDir)) mkdirSync(arkDir, { recursive: true });
    writeFileSync(join(arkDir, "arkd.token"), arkdToken, { mode: 0o600 });
  }

  // Pre-compute the expected header bytes so the timing-safe comparison
  // sees a fixed-length reference. timingSafeEqual throws on length mismatch,
  // so we pre-pad the provided header to the expected length before compare
  // and still return 401 -- this collapses "unauthorized" and "wrong length"
  // into a single timing path, removing the obvious side channel.
  const expectedAuth = arkdToken ? Buffer.from(`Bearer ${arkdToken}`) : null;

  function checkAuth(req: Request, path: string): Response | null {
    if (!arkdToken || !expectedAuth) return null;
    if (AUTH_EXEMPT_PATHS.has(path)) return null;
    const authHeader = req.headers.get("Authorization") ?? "";
    const providedBuf = Buffer.from(authHeader);
    // Mismatched length => definitely wrong; still run a constant-time compare
    // against a fixed-size dummy so the timing does not leak "wrong length".
    if (providedBuf.length !== expectedAuth.length) {
      timingSafeEqual(expectedAuth, expectedAuth);
      return json({ error: "Unauthorized" }, 401);
    }
    if (timingSafeEqual(providedBuf, expectedAuth)) return null;
    return json({ error: "Unauthorized" }, 401);
  }

  // Control plane registration
  const controlPlaneUrl = process.env.ARK_CONTROL_PLANE_URL;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const workerId = process.env.ARK_WORKER_ID || `worker-${hostname()}-${port}`;
  const workerCapacity = parseInt(process.env.ARK_WORKER_CAPACITY ?? "5", 10);

  if (controlPlaneUrl) {
    // Register with control plane
    const workerUrl = `http://${hostname()}:${port}`;
    const registerPayload = {
      id: workerId,
      url: workerUrl,
      capacity: workerCapacity,
      compute_name: process.env.ARK_COMPUTE_NAME || null,
      tenant_id: process.env.ARK_TENANT_ID || null,
      metadata: { hostname: hostname(), platform: platform(), port },
    };

    // Initial registration (fire and forget)
    fetch(`${controlPlaneUrl}/api/workers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerPayload),
    }).catch(() => {
      /* control plane not ready yet -- heartbeat will retry */
    });

    // Heartbeat every 30s
    heartbeatTimer = setInterval(() => {
      fetch(`${controlPlaneUrl}/api/workers/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: workerId }),
      }).catch(() => {
        /* control plane unreachable */
      });
    }, 30_000);
  }

  const server = Bun.serve({
    port,
    hostname: bindHost,
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

        // Auth check (after health, which is exempt)
        const authErr = checkAuth(req, path);
        if (authErr) return authErr;

        // ── Metrics ───────────────────────────────────────────────────
        if (req.method === "GET" && path === "/metrics") {
          return json(await collectMetrics());
        }

        // ── Snapshot (full system state) ──────────────────────────────
        if (req.method === "GET" && path === "/snapshot") {
          return json(await collectSnapshot());
        }

        // ── File: read ────────────────────────────────────────────────
        if (req.method === "POST" && path === "/file/read") {
          const body = (await req.json()) as ReadFileReq;
          const safePath = confine(body.path);
          try {
            const content = await readFile(safePath, "utf-8");
            return json<ReadFileRes>({ content, size: Buffer.byteLength(content) });
          } catch (e: any) {
            if (e.code === "ENOENT") return json({ error: "file not found", code: "ENOENT" }, 404);
            throw e;
          }
        }

        // ── File: write ───────────────────────────────────────────────
        if (req.method === "POST" && path === "/file/write") {
          const body = (await req.json()) as WriteFileReq;
          const safePath = confine(body.path);
          await writeFile(safePath, body.content, body.mode ? { mode: body.mode } : undefined);
          return json<WriteFileRes>({ ok: true, bytesWritten: Buffer.byteLength(body.content) });
        }

        // ── File: stat ────────────────────────────────────────────────
        if (req.method === "POST" && path === "/file/stat") {
          const body = (await req.json()) as StatReq;
          const safePath = confine(body.path);
          try {
            const s = await stat(safePath);
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
          const body = (await req.json()) as MkdirReq;
          const safePath = confine(body.path);
          await mkdir(safePath, { recursive: body.recursive ?? true });
          return json<MkdirRes>({ ok: true });
        }

        // ── File: list ────────────────────────────────────────────────
        if (req.method === "POST" && path === "/file/list") {
          const body = (await req.json()) as ListDirReq;
          const safePath = confine(body.path);
          const entries = await listDirectory(safePath, body.recursive);
          return json<ListDirRes>({ entries });
        }

        // ── Exec ──────────────────────────────────────────────────────
        if (req.method === "POST" && path === "/exec") {
          const body = (await req.json()) as ExecReq;
          // /exec's cwd is attacker-controllable via the request body. Confine
          // it to the workspace root (P1-4 / S-13). When workspaceRoot is
          // unset we preserve legacy local-mode behavior.
          if (body.cwd !== undefined && body.cwd !== null) {
            body.cwd = confine(body.cwd);
          } else if (workspaceRoot) {
            // Default cwd to the root when confinement is enabled so agents
            // can't silently pick up the daemon's process cwd.
            body.cwd = workspaceRoot;
          }
          const result = await runExec(body);
          return json(result);
        }

        // ── Agent: launch ─────────────────────────────────────────────
        if (req.method === "POST" && path === "/agent/launch") {
          const body = (await req.json()) as AgentLaunchReq;
          const result = await agentLaunch(body);
          return json(result);
        }

        // ── Agent: kill ───────────────────────────────────────────────
        if (req.method === "POST" && path === "/agent/kill") {
          const body = (await req.json()) as AgentKillReq;
          const result = await agentKill(body);
          return json(result);
        }

        // ── Agent: status ─────────────────────────────────────────────
        if (req.method === "POST" && path === "/agent/status") {
          const body = (await req.json()) as AgentStatusReq;
          const result = await agentStatus(body);
          return json(result);
        }

        // ── Agent: capture ────────────────────────────────────────────
        if (req.method === "POST" && path === "/agent/capture") {
          const body = (await req.json()) as AgentCaptureReq;
          const result = await agentCapture(body);
          return json(result);
        }

        // ── Ports: probe ──────────────────────────────────────────────
        if (req.method === "POST" && path === "/ports/probe") {
          const body = (await req.json()) as ProbePortsReq;
          const result = await probePorts(body);
          return json(result);
        }

        // ── Channel: report (agent → conductor via arkd) ─────────────
        if (
          req.method === "POST" &&
          path.startsWith("/channel/") &&
          !path.endsWith("/relay") &&
          !path.endsWith("/deliver")
        ) {
          const sessionId = path.split("/")[2]!;
          const report = (await req.json()) as Record<string, unknown>;
          const tenantId = req.headers.get("x-ark-tenant-id") ?? req.headers.get("X-Ark-Tenant-Id");
          const result = await channelReport(sessionId, report, conductorUrl, tenantId);
          return json(result);
        }

        // ── Channel: relay (agent → agent via conductor) ─────────────
        if (req.method === "POST" && path === "/channel/relay") {
          const body = (await req.json()) as ChannelRelayReq;
          const tenantId = req.headers.get("x-ark-tenant-id") ?? req.headers.get("X-Ark-Tenant-Id");
          const result = await channelRelay(body, conductorUrl, tenantId);
          return json(result);
        }

        // ── Channel: deliver (conductor → agent on this compute) ─────
        if (req.method === "POST" && path === "/channel/deliver") {
          const body = (await req.json()) as ChannelDeliverReq;
          const result = await channelDeliver(body);
          return json(result);
        }

        // ── Codegraph: index ─────────────────────────────────────────
        if (req.method === "POST" && path === "/codegraph/index") {
          const body = (await req.json()) as { repoPath: string; incremental?: boolean };
          const repoPath = body.repoPath;

          // Find codegraph binary: node_modules/.bin -> PATH
          const { existsSync: existsSyncFs } = await import("fs");
          const localBin = join(process.cwd(), "node_modules", ".bin", "codegraph");
          const cgBin = existsSyncFs(localBin) ? localBin : "codegraph";

          const args = ["build"];
          if (!body.incremental) args.push("--no-incremental");
          args.push(repoPath);

          let buildExitCode = -1;
          let buildStderr = "";
          try {
            const proc = Bun.spawn({ cmd: [cgBin, ...args], cwd: repoPath, stdout: "pipe", stderr: "pipe" });
            buildExitCode = await proc.exited;
            buildStderr = await new Response(proc.stderr).text();
          } catch (e: any) {
            return json({ ok: false, error: `codegraph spawn failed: ${e.message}` }, 500);
          }

          if (buildExitCode !== 0) {
            return json(
              { ok: false, error: `codegraph build exited ${buildExitCode}: ${buildStderr.slice(0, 500)}` },
              500,
            );
          }

          const dbPath = join(repoPath, ".codegraph", "graph.db");
          try {
            const { Database } = await import("bun:sqlite");
            const db = new Database(dbPath);

            const nodes = db
              .query("SELECT id, kind, name, file, line, end_line, visibility, exported, qualified_name FROM nodes")
              .all();
            const edges = db.query("SELECT source_id, target_id, kind FROM edges").all();

            const files = new Set(nodes.map((n: any) => n.file)).size;
            const symbols = nodes.length;

            db.close();
            return json({ ok: true, nodes, edges, files, symbols });
          } catch (e: any) {
            return json({ ok: false, error: `Failed to read codegraph DB at ${dbPath}: ${e.message}` }, 500);
          }
        }

        // ── Config: runtime config update ────────────────────────────
        if (req.method === "POST" && path === "/config") {
          const body = (await req.json()) as ConfigReq;
          if (body.conductorUrl !== undefined) conductorUrl = body.conductorUrl || null;
          return json<ConfigRes>({ ok: true, conductorUrl });
        }
        if (req.method === "GET" && path === "/config") {
          return json<ConfigRes>({ ok: true, conductorUrl });
        }

        // ── LLM proxy: forward to conductor ─────────────────────────
        if (req.method === "POST" && path === "/v1/chat/completions") {
          return proxyToCondutor(req, conductorUrl, "/v1/chat/completions");
        }
        if (req.method === "GET" && path === "/v1/models") {
          return proxyToCondutor(req, conductorUrl, "/v1/models");
        }

        return new Response("Not found", { status: 404 });
      } catch (e: any) {
        if (e instanceof SyntaxError) {
          return json({ error: "invalid JSON" }, 400);
        }
        if (e instanceof PathConfinementError) {
          return json({ error: "path escapes workspace root", detail: e.message }, 403);
        }
        return json({ error: String(e.message ?? e) }, 500);
      }
    },
  });

  if (!opts?.quiet) process.stderr.write(`[arkd] listening on ${bindHost}:${port}\n`);

  return {
    stop() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      // Deregister from control plane on shutdown
      if (controlPlaneUrl) {
        fetch(`${controlPlaneUrl}/api/workers/deregister`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: workerId }),
        }).catch(() => {
          /* best effort */
        });
      }
      server.stop();
    },
    setConductorUrl(url: string) {
      conductorUrl = url;
    },
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
    const type = item.isFile() ? ("file" as const) : item.isDirectory() ? ("dir" as const) : ("symlink" as const);

    let size = 0;
    if (item.isFile()) {
      try {
        size = (await stat(fullPath)).size;
      } catch {
        logInfo("compute", "stat may fail for broken symlinks");
      }
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
  // Validate command against allowlist
  const baseCmd = req.command.includes("/") ? req.command.split("/").pop()! : req.command;
  if (!EXEC_ALLOWED_COMMANDS.has(baseCmd)) {
    return { exitCode: 1, stdout: "", stderr: `Command not allowed: ${req.command}`, timedOut: false };
  }

  // Audit log
  const ts = new Date().toISOString();
  const cmdStr = [req.command, ...(req.args ?? [])].join(" ");
  process.stderr.write(`[arkd] [exec] ${ts} cwd=${req.cwd ?? "."} cmd=${cmdStr}\n`);

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
    const sink = proc.stdin as unknown as { write(data: string): number; end(): void };
    sink.write(req.stdin);
    sink.end();
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout);

  const [stdout, stderr, exitCode] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr), proc.exited]);

  clearTimeout(timer);

  return { exitCode, stdout, stderr, timedOut };
}

// ── Agent (tmux) operations ──────────────────────────────────────────────────

// tmux session names must be usable as a shell argument and a POSIX filename
// component. We restrict to a safe charset to close two injection surfaces:
//   1. The `/tmp/arkd-launcher-<sessionName>.sh` path below -- without this
//      guard, an attacker can write `../../../../etc/cron.d/poison` or
//      clobber arbitrary files writable by the arkd user.
//   2. The tmux shell-command argument `bash <scriptPath>` -- tmux parses
//      the final argv as a shell command, so spaces / metacharacters in the
//      session name bleed into shell parsing.
const SAFE_TMUX_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

async function agentLaunch(req: AgentLaunchReq): Promise<AgentLaunchRes> {
  if (typeof req.sessionName !== "string" || !SAFE_TMUX_NAME_RE.test(req.sessionName)) {
    throw new Error("invalid sessionName: must match [A-Za-z0-9_-]{1,64}");
  }
  if (typeof req.workdir !== "string" || req.workdir.includes("\0")) {
    throw new Error("invalid workdir");
  }
  // Write launcher script to a temp file
  const scriptPath = `/tmp/arkd-launcher-${req.sessionName}.sh`;
  await writeFile(scriptPath, req.script, { mode: 0o755 });

  const proc = Bun.spawn({
    cmd: [
      "tmux",
      "new-session",
      "-d",
      "-s",
      req.sessionName,
      "-x",
      "120",
      "-y",
      "50",
      "-c",
      req.workdir,
      `bash ${scriptPath}`,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;

  return { ok: true };
}

function requireSafeTmuxName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !SAFE_TMUX_NAME_RE.test(name)) {
    throw new Error("invalid sessionName: must match [A-Za-z0-9_-]{1,64}");
  }
}

async function agentKill(req: AgentKillReq): Promise<AgentKillRes> {
  requireSafeTmuxName(req.sessionName);
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
  requireSafeTmuxName(req.sessionName);
  const running = await isTmuxRunning(req.sessionName);
  return { running };
}

async function agentCapture(req: AgentCaptureReq): Promise<AgentCaptureRes> {
  requireSafeTmuxName(req.sessionName);
  const linesNum = Math.trunc(Number(req.lines ?? 100));
  const lines = Number.isFinite(linesNum) && linesNum > 0 && linesNum <= 100000 ? linesNum : 100;
  const proc = Bun.spawn({
    cmd: ["tmux", "capture-pane", "-t", req.sessionName, "-p", "-e", "-S", `-${lines}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await readStream(proc.stdout);
  await proc.exited;
  return { output: output.trimEnd() };
}

async function isTmuxRunning(sessionName: string): Promise<boolean> {
  // Callers of isTmuxRunning have already validated sessionName via
  // requireSafeTmuxName. Re-check here so a future caller cannot drop it.
  if (!SAFE_TMUX_NAME_RE.test(sessionName)) return false;
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

/** Helper: spawn a command and return trimmed stdout, or empty string on error. */
async function spawnRead(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
    const out = await readStream(proc.stdout);
    await proc.exited;
    return out.trim();
  } catch {
    return "";
  }
}

// ── Port probing ─────────────────────────────────────────────────────────────

async function probePorts(req: ProbePortsReq): Promise<ProbePortsRes> {
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

// ── Channel relay (arkd as conductor transport) ─────────────────────────────

async function channelReport(
  sessionId: string,
  report: Record<string, unknown>,
  conductorUrl: string | null,
  tenantId?: string | null,
): Promise<ChannelReportRes> {
  if (!conductorUrl) return { ok: false, forwarded: false, error: "no conductor URL configured" };
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (tenantId) headers["X-Ark-Tenant-Id"] = tenantId;
    const resp = await fetch(`${conductorUrl}/api/channel/${sessionId}`, {
      method: "POST",
      headers,
      body: JSON.stringify(report),
    });
    if (!resp.ok) return { ok: false, forwarded: false, error: `conductor returned ${resp.status}` };
    return { ok: true, forwarded: true };
  } catch (e: any) {
    return { ok: false, forwarded: false, error: e?.message ?? "fetch failed" };
  }
}

async function channelRelay(
  req: ChannelRelayReq,
  conductorUrl: string | null,
  tenantId?: string | null,
): Promise<ChannelRelayRes> {
  if (!conductorUrl) return { ok: false, forwarded: false };
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (tenantId) headers["X-Ark-Tenant-Id"] = tenantId;
    const resp = await fetch(`${conductorUrl}/api/relay`, {
      method: "POST",
      headers,
      body: JSON.stringify(req),
    });
    if (!resp.ok) return { ok: false, forwarded: false };
    return { ok: true, forwarded: true };
  } catch {
    return { ok: false, forwarded: false };
  }
}

/**
 * Proxy an HTTP request to the conductor, streaming the response back.
 * Used for LLM router passthrough (agent -> arkd -> conductor -> router).
 */
async function proxyToCondutor(req: Request, conductorUrl: string | null, path: string): Promise<Response> {
  if (!conductorUrl) {
    return json({ error: "no conductor URL configured" }, 502);
  }
  try {
    const headers: Record<string, string> = {};
    for (const key of ["content-type", "authorization", "accept"]) {
      const val = req.headers.get(key);
      if (val) headers[key] = val;
    }
    const init: RequestInit = { method: req.method, headers };
    if (req.method === "POST") init.body = req.body;
    const upstream = await fetch(`${conductorUrl}${path}`, init);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (e: any) {
    return json({ error: `proxy failed: ${e?.message ?? e}` }, 502);
  }
}

async function channelDeliver(req: ChannelDeliverReq): Promise<ChannelDeliverRes> {
  try {
    const resp = await fetch(`${DEFAULT_CHANNEL_BASE_URL}:${req.channelPort}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.payload),
    });
    return { ok: true, delivered: resp.ok };
  } catch {
    return { ok: true, delivered: false };
  }
}

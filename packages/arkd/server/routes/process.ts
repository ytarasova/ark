/**
 * /process/* -- generic per-compute process supervisor.
 *
 * arkd has no agent-specific knowledge here: it spawns, kills, and tracks
 * pids against caller-supplied handles. The agent runtime layer (claude-code,
 * claude-agent, codex, gemini, goose) decides what to launch -- a tmux session,
 * a plain bash launcher, etc. -- and uses the same three primitives:
 *
 *   POST /process/spawn  { handle, cmd, args, workdir, env?, logPath? }
 *   POST /process/kill   { handle, signal? }
 *   POST /process/status { handle }
 *
 * Tracking lives in a module-level Map. A process entry is retained after
 * exit so callers can read the final exitCode via /process/status until the
 * map is reset. There is no LRU cap today; callers spawning thousands of
 * handles per arkd instance should call /process/kill (which leaves the
 * entry in place with exited=true) and budget accordingly. This matches the
 * one-handle-per-session shape every runtime uses today.
 */

import { mkdir, appendFile, stat } from "fs/promises";
import { dirname } from "path";
import { json } from "../helpers.js";
import { requireSafeTmuxName } from "../../common/validation.js";
import { SAFE_TMUX_NAME_RE } from "../../common/constants.js";
import { type RouteCtx } from "../route-ctx.js";
import { logDebug, logInfo, logWarn } from "../../../core/observability/structured-log.js";
import type {
  ProcessSpawnReq,
  ProcessSpawnRes,
  ProcessKillReq,
  ProcessKillRes,
  ProcessStatusReq,
  ProcessStatusRes,
} from "../../common/types.js";

/**
 * Local typed shim for the subset of Bun.spawn we need here. The shared
 * `BunLike` type in internal.ts is intentionally narrow (it predates this
 * route family) -- extending it would touch every route module, so we keep
 * the broader surface local. Mirrors the real Bun API for stdout/stderr
 * sinks and the .unref() detach hook.
 */
type SpawnStdio = "pipe" | "ignore" | "inherit";

interface SpawnedProc {
  pid: number;
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  kill(): void;
  unref?(): void;
}

interface BunSpawnFn {
  spawn(opts: {
    cmd: string[];
    cwd?: string;
    env?: Record<string, string>;
    stdin?: SpawnStdio;
    stdout?: SpawnStdio;
    stderr?: SpawnStdio;
  }): SpawnedProc;
}

const Bun = (globalThis as unknown as { Bun: BunSpawnFn }).Bun;

interface ProcessEntry {
  pid: number;
  exitCode: number | null;
  exited: boolean;
  logPath?: string;
}

const processes = new Map<string, ProcessEntry>();

/**
 * Test-only helper: clear the in-memory process map. Production code never
 * needs this -- the map is bounded by the runtime layer's own session
 * lifecycle, and entries cost a handful of bytes each.
 */
export function _resetForTests(): void {
  processes.clear();
}

/**
 * Pipe a stream's bytes to the log file in append mode. Errors are swallowed
 * because a broken log file must never crash arkd or the supervised process;
 * the caller will surface the missing log via /process/status if it matters.
 */
async function pumpToFile(stream: ReadableStream<Uint8Array>, path: string): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.byteLength > 0) {
        try {
          await appendFile(path, Buffer.from(value));
        } catch {
          /* log file removed mid-stream or permission flipped -- drop the rest */
          return;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/**
 * True when `process.kill(pid, 0)` reports the pid is still reachable.
 * `kill -0` is the POSIX liveness probe -- it sends no signal but raises
 * ESRCH when the pid is gone (reaped or never existed).
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function spawnProcess(req: ProcessSpawnReq): Promise<ProcessSpawnRes> {
  requireSafeTmuxName(req.handle);
  if (typeof req.cmd !== "string" || req.cmd.length === 0) {
    throw new Error("`cmd` must be a non-empty string");
  }
  if (!Array.isArray(req.args)) {
    throw new Error("`args` must be an array");
  }
  if (typeof req.workdir !== "string" || req.workdir.length === 0) {
    throw new Error("`workdir` must be a non-empty string");
  }

  // Validate cwd up front. Bun.spawn surfaces a missing cwd as
  // `ENOENT posix_spawn '<cmd>'`, which makes us blame the executable
  // when the real cause is the working directory. Stat first so the
  // failure mode is unambiguous. See #473.
  try {
    const st = await stat(req.workdir);
    if (!st.isDirectory()) {
      throw new Error(`workdir is not a directory: ${req.workdir}`);
    }
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      throw new Error(`workdir does not exist: ${req.workdir}`);
    }
    throw e;
  }

  // Pre-create the log directory so the pump can append without race.
  if (req.logPath) {
    await mkdir(dirname(req.logPath), { recursive: true });
  }

  const wantPipes = Boolean(req.logPath);
  let child: SpawnedProc;
  try {
    child = Bun.spawn({
      cmd: [req.cmd, ...req.args],
      cwd: req.workdir,
      env: { ...process.env, ...(req.env ?? {}) } as Record<string, string>,
      stdout: wantPipes ? "pipe" : "ignore",
      stderr: wantPipes ? "pipe" : "ignore",
    });
  } catch (e: any) {
    // Capture errno + syscall + the resolved exec name so the conductor
    // sees what actually went wrong, not just `posix_spawn '<cmd>'`. See #473.
    const errno = e?.errno ?? e?.code ?? "unknown";
    const syscall = e?.syscall ?? "spawn";
    throw new Error(`${syscall} failed (${errno}) cmd=${req.cmd} workdir=${req.workdir}: ${e?.message ?? String(e)}`);
  }

  const entry: ProcessEntry = {
    pid: child.pid,
    exitCode: null,
    exited: false,
    logPath: req.logPath,
  };
  processes.set(req.handle, entry);
  logInfo("compute", "arkd /process/spawn: spawned", {
    handle: req.handle,
    pid: child.pid,
    cmd: req.cmd,
    argsCount: req.args.length,
    workdir: req.workdir,
    logPath: req.logPath,
  });

  // Detach so arkd shutdown does not wait on the child. Bun returns a
  // subprocess with .unref(); guard the call for older Bun builds.
  if (typeof child.unref === "function") child.unref();

  // Track exit so /process/status can return the final code after the
  // child exits without us having to poll wait4().
  void child.exited.then((code) => {
    entry.exited = true;
    entry.exitCode = typeof code === "number" ? code : null;
    logInfo("compute", "arkd /process/spawn: child exited", {
      handle: req.handle,
      pid: child.pid,
      exitCode: entry.exitCode,
    });
  });

  // Drain stdout / stderr to the log file when requested. We write both
  // streams to the same file in arrival order; ordering between stdout
  // and stderr is best-effort (matches `bash >>file 2>&1`).
  if (wantPipes && req.logPath) {
    if (child.stdout) void pumpToFile(child.stdout, req.logPath);
    if (child.stderr) void pumpToFile(child.stderr, req.logPath);
  }

  return { ok: true, pid: child.pid };
}

async function killProcess(req: ProcessKillReq): Promise<ProcessKillRes> {
  requireSafeTmuxName(req.handle);
  const signal = req.signal ?? "SIGTERM";
  if (signal !== "SIGTERM" && signal !== "SIGKILL") {
    throw new Error("`signal` must be 'SIGTERM' or 'SIGKILL'");
  }

  const entry = processes.get(req.handle);
  if (!entry) {
    logDebug("compute", `arkd /process/kill: unknown handle ${req.handle}`);
    return { ok: true, wasRunning: false };
  }

  const wasRunning = !entry.exited && pidAlive(entry.pid);
  if (!wasRunning) {
    logDebug("compute", `arkd /process/kill: handle ${req.handle} already exited`);
    return { ok: true, wasRunning: false };
  }

  logInfo("compute", "arkd /process/kill: sending signal", {
    handle: req.handle,
    pid: entry.pid,
    signal,
  });
  try {
    process.kill(entry.pid, signal);
  } catch {
    // Race: process exited between the liveness probe and the signal.
    logWarn("compute", `arkd /process/kill: signal raced with exit`, {
      handle: req.handle,
      pid: entry.pid,
    });
    return { ok: true, wasRunning: true };
  }

  // SIGTERM gets a 1s grace before we escalate to SIGKILL. SIGKILL is
  // synchronous and skips the grace.
  if (signal === "SIGTERM") {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && pidAlive(entry.pid)) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (pidAlive(entry.pid)) {
      try {
        process.kill(entry.pid, "SIGKILL");
      } catch {
        /* already gone in the gap */
      }
    }
  }

  return { ok: true, wasRunning: true };
}

function statusProcess(req: ProcessStatusReq): ProcessStatusRes {
  requireSafeTmuxName(req.handle);
  const entry = processes.get(req.handle);
  if (!entry) return { running: false };
  const running = !entry.exited && pidAlive(entry.pid);
  const res: ProcessStatusRes = { running, pid: entry.pid };
  if (entry.exited && entry.exitCode !== null) res.exitCode = entry.exitCode;
  return res;
}

export async function handleProcessRoutes(req: Request, path: string, _ctx: RouteCtx): Promise<Response | null> {
  if (req.method === "POST" && path === "/process/spawn") {
    let body: ProcessSpawnReq;
    try {
      body = (await req.json()) as ProcessSpawnReq;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.handle !== "string" || !SAFE_TMUX_NAME_RE.test(body.handle)) {
      return json({ error: "invalid `handle`: must match [A-Za-z0-9_-]{1,64}" }, 400);
    }
    try {
      const res = await spawnProcess(body);
      return json(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json({ error: msg }, 400);
    }
  }

  if (req.method === "POST" && path === "/process/kill") {
    let body: ProcessKillReq;
    try {
      body = (await req.json()) as ProcessKillReq;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.handle !== "string" || !SAFE_TMUX_NAME_RE.test(body.handle)) {
      return json({ error: "invalid `handle`: must match [A-Za-z0-9_-]{1,64}" }, 400);
    }
    try {
      const res = await killProcess(body);
      return json(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json({ error: msg }, 400);
    }
  }

  if (req.method === "POST" && path === "/process/status") {
    let body: ProcessStatusReq;
    try {
      body = (await req.json()) as ProcessStatusReq;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.handle !== "string" || !SAFE_TMUX_NAME_RE.test(body.handle)) {
      return json({ error: "invalid `handle`: must match [A-Za-z0-9_-]{1,64}" }, 400);
    }
    try {
      const res = statusProcess(body);
      return json(res);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json({ error: msg }, 400);
    }
  }

  return null;
}

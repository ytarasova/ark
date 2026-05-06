/**
 * /exec route: process spawn with allowlist + timeout.
 *
 * Extracted from server.ts; behavior unchanged. The request cwd is
 * confined to ctx.workspaceRoot when set, defaulting to the workspace
 * root when the caller omits cwd.
 */

import type { ExecReq, ExecRes } from "../../common/types.js";
import { EXEC_ALLOWED_COMMANDS } from "../exec-allowlist.js";
import { json, readStream, type BunLike } from "../helpers.js";
import { type RouteCtx } from "../route-ctx.js";

async function runExec(req: ExecReq): Promise<ExecRes> {
  const Bun = (globalThis as unknown as { Bun: BunLike }).Bun;

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
    // SIGKILL beats SIGTERM here: callers (the test suite, sage hooks)
    // pass `command: "sh", args: ["-c", "sleep 60"]` shapes whose shell
    // wrapper may not propagate SIGTERM to grandchildren before we
    // give up waiting. SIGKILL drops `sh` immediately so the pipes
    // close even if the inner `sleep` orphans into init.
    proc.kill("SIGKILL");
  }, timeout);

  // Race the stream reads against the timeout: when the proc is killed
  // for timeout reasons, an orphaned grandchild on Linux can keep its
  // inherited stdout/stderr fds open even after `sh` exits, and a
  // naive `readStream` then never resolves. Drain best-effort with a
  // short grace window once we've decided we're timing out.
  const exitCode = await proc.exited;
  let stdout = "";
  let stderr = "";
  if (timedOut) {
    stdout = await raceReadStream(proc.stdout, 200);
    stderr = await raceReadStream(proc.stderr, 200);
  } else {
    [stdout, stderr] = await Promise.all([readStream(proc.stdout), readStream(proc.stderr)]);
  }
  clearTimeout(timer);

  return { exitCode, stdout, stderr, timedOut };
}

/**
 * Read a stream with an upper-bound timeout. Returns whatever bytes were
 * available before the deadline; on timeout the partial content is
 * returned rather than blocking on a never-closing fd.
 */
async function raceReadStream(stream: ReadableStream<Uint8Array> | null, timeoutMs: number): Promise<string> {
  if (!stream) return "";
  const drain = readStream(stream);
  const deadline = new Promise<string>((resolve) => setTimeout(() => resolve(""), timeoutMs));
  return await Promise.race([drain, deadline]);
}

export async function handleExecRoutes(req: Request, path: string, ctx: RouteCtx): Promise<Response | null> {
  if (req.method === "POST" && path === "/exec") {
    const body = (await req.json()) as ExecReq;
    // /exec's cwd is attacker-controllable via the request body. Confine
    // it to the workspace root (P1-4 / S-13). When workspaceRoot is
    // unset we preserve legacy local-mode behavior.
    if (body.cwd !== undefined && body.cwd !== null) {
      body.cwd = ctx.confine(body.cwd);
    } else if (ctx.workspaceRoot) {
      // Default cwd to the root when confinement is enabled so agents
      // can't silently pick up the daemon's process cwd.
      body.cwd = ctx.workspaceRoot;
    }
    const result = await runExec(body);
    return json(result);
  }
  return null;
}

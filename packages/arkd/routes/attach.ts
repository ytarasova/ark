/**
 * /agent/attach/* -- live tmux pane attach with PTY forwarding.
 *
 * The attach flow:
 *  1. POST /agent/attach/open   { sessionName } -> { ok, streamHandle, initialBuffer }
 *     Captures current pane + mkfifo + starts tmux pipe-pane writing to the fifo.
 *  2. GET  /agent/attach/stream?handle=<h> -> long-lived chunked body piping
 *     fifo bytes to the HTTP response (kept open across quiet periods).
 *  3. POST /agent/attach/input  { sessionName, data }       -> tmux send-keys -l
 *  4. POST /agent/attach/resize { sessionName, cols, rows } -> tmux resize-window
 *  5. POST /agent/attach/close  { streamHandle } -> tmux pipe-pane off + unlink fifo
 *
 * Ported from the flat arkd/server.ts into the route-family split.
 */

import { tmpdir } from "os";
import { join } from "path";
import { unlink } from "fs/promises";
import { existsSync, createReadStream } from "fs";
import type {
  AgentAttachOpenReq,
  AgentAttachOpenRes,
  AgentAttachInputReq,
  AgentAttachInputRes,
  AgentAttachResizeReq,
  AgentAttachResizeRes,
  AgentAttachCloseReq,
  AgentAttachCloseRes,
} from "../types.js";
import { requireSafeTmuxName, readStream, json, type BunLike } from "../internal.js";

const Bun = (globalThis as unknown as { Bun: BunLike }).Bun;

/**
 * An open attach handle backs one client WebSocket connection. The server
 * daemon's /terminal/:sessionId WS proxy opens one handle per browser tab.
 * Live pane bytes are streamed via `tmux pipe-pane` to a named fifo; the
 * /agent/attach/stream endpoint opens the fifo and pipes it to the HTTP
 * response body. Input / resize hit /agent/attach/{input,resize}.
 * /agent/attach/close tears the fifo down.
 *
 * The fifo lives under `tmpdir()/arkd-attach-<random>.fifo` so multiple
 * concurrent attachers on the same host don't collide. Each open handle
 * owns exactly one fifo; a single tmux pane can be attached by multiple
 * clients, each with their own handle + fifo.
 */
interface AttachHandle {
  sessionName: string;
  fifoPath: string;
  openedAt: number;
  closed: boolean;
}

const attachStreams = new Map<string, AttachHandle>();
let attachCounter = 0;

async function isTmuxRunning(sessionName: string): Promise<boolean> {
  const proc = Bun.spawn({
    cmd: ["tmux", "has-session", "-t", sessionName],
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  return code === 0;
}

async function agentAttachOpen(req: AgentAttachOpenReq): Promise<AgentAttachOpenRes> {
  requireSafeTmuxName(req.sessionName);
  if (!(await isTmuxRunning(req.sessionName))) {
    throw new Error(`tmux session not running: ${req.sessionName}`);
  }

  // Capture the current pane so the caller can paint the UI immediately.
  const capture = Bun.spawn({
    cmd: ["tmux", "capture-pane", "-t", req.sessionName, "-p", "-e", "-J"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const initialBuffer = (await readStream(capture.stdout)).trimEnd();
  await capture.exited;

  // Allocate a fifo for live pane bytes. Random suffix is ample entropy since
  // the value never leaves this host and the fifo is unlinked on close.
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const fifoPath = join(tmpdir(), `arkd-attach-${suffix}.fifo`);

  try {
    const mk = Bun.spawn({ cmd: ["mkfifo", fifoPath], stdout: "pipe", stderr: "pipe" });
    const code = await mk.exited;
    if (code !== 0) throw new Error(`mkfifo exited ${code}`);
  } catch (e: any) {
    throw new Error(`failed to create fifo: ${e?.message ?? e}`);
  }

  // Start tmux pipe-pane writing to the fifo. Shell redirect is safe because
  // fifoPath is machine-generated with random suffix.
  const pipeProc = Bun.spawn({
    cmd: ["tmux", "pipe-pane", "-t", req.sessionName, "-O", `cat >> ${fifoPath}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  await pipeProc.exited;

  const streamHandle = `attach-${Date.now()}-${++attachCounter}`;
  attachStreams.set(streamHandle, {
    sessionName: req.sessionName,
    fifoPath,
    openedAt: Date.now(),
    closed: false,
  });
  return { ok: true, streamHandle, initialBuffer };
}

async function agentAttachInput(req: AgentAttachInputReq): Promise<AgentAttachInputRes> {
  requireSafeTmuxName(req.sessionName);
  if (typeof req.data !== "string") {
    throw new Error("data must be a string");
  }
  // `send-keys -l` passes data literally so escape sequences (arrows, Ctrl+C,
  // bracketed paste markers) reach the pane untouched.
  const proc = Bun.spawn({
    cmd: ["tmux", "send-keys", "-t", req.sessionName, "-l", req.data],
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return { ok: true };
}

async function agentAttachResize(req: AgentAttachResizeReq): Promise<AgentAttachResizeRes> {
  requireSafeTmuxName(req.sessionName);
  const cols = Math.max(1, Math.min(1000, Math.trunc(Number(req.cols))));
  const rows = Math.max(1, Math.min(1000, Math.trunc(Number(req.rows))));
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    throw new Error("cols and rows must be finite numbers");
  }
  const proc = Bun.spawn({
    cmd: ["tmux", "resize-window", "-t", req.sessionName, "-x", String(cols), "-y", String(rows)],
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return { ok: true };
}

async function agentAttachClose(req: AgentAttachCloseReq): Promise<AgentAttachCloseRes> {
  if (typeof req.streamHandle !== "string" || req.streamHandle.length === 0) {
    throw new Error("streamHandle required");
  }
  const handle = attachStreams.get(req.streamHandle);
  attachStreams.delete(req.streamHandle);
  if (handle) {
    handle.closed = true;
    // Stop pipe-pane and unlink the fifo. Errors are swallowed because close
    // must be idempotent; the tmux pane may already be gone.
    try {
      const stopProc = Bun.spawn({
        cmd: ["tmux", "pipe-pane", "-t", handle.sessionName],
        stdout: "pipe",
        stderr: "pipe",
      });
      await stopProc.exited;
    } catch {
      /* tmux session may already be dead */
    }
    try {
      await unlink(handle.fifoPath);
    } catch {
      /* already gone */
    }
  }
  return { ok: true };
}

/**
 * Stream live pane bytes for an open attach handle. Returns an HTTP chunked
 * response that emits bytes from the fifo until the caller disconnects, the
 * handle is closed, or the tmux session ends.
 */
function agentAttachStreamResponse(streamHandle: string): Response {
  const handle = attachStreams.get(streamHandle);
  if (!handle) {
    return json({ error: "stream handle not found" }, 404);
  }
  const { fifoPath } = handle;
  if (!existsSync(fifoPath)) {
    return json({ error: "fifo missing" }, 410);
  }

  // Use Node createReadStream -- Bun.file on a fifo would terminate on EOF
  // whenever the writer pauses; createReadStream keeps the fd open so the
  // response stays open across quiet periods.
  const nodeStream = createReadStream(fifoPath);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer | string) => {
        try {
          const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          controller.enqueue(new Uint8Array(bytes));
        } catch {
          /* controller closed */
        }
      });
      nodeStream.on("end", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
      nodeStream.on("error", () => {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      try {
        nodeStream.close();
      } catch {
        /* best effort */
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Dispatcher entry point. Returns null when no attach route matches so the
 * caller falls through to the next route family.
 */
export async function handleAttachRoutes(req: Request, path: string): Promise<Response | null> {
  if (req.method === "POST" && path === "/agent/attach/open") {
    const body = (await req.json()) as AgentAttachOpenReq;
    return json(await agentAttachOpen(body));
  }
  if (req.method === "POST" && path === "/agent/attach/input") {
    const body = (await req.json()) as AgentAttachInputReq;
    return json(await agentAttachInput(body));
  }
  if (req.method === "POST" && path === "/agent/attach/resize") {
    const body = (await req.json()) as AgentAttachResizeReq;
    return json(await agentAttachResize(body));
  }
  if (req.method === "POST" && path === "/agent/attach/close") {
    const body = (await req.json()) as AgentAttachCloseReq;
    return json(await agentAttachClose(body));
  }
  if (req.method === "GET" && path === "/agent/attach/stream") {
    const url = new URL(req.url);
    const streamHandle = url.searchParams.get("handle");
    if (!streamHandle) return json({ error: "handle query param required" }, 400);
    return agentAttachStreamResponse(streamHandle);
  }
  return null;
}

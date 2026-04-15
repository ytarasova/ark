/**
 * Terminal bridge -- connects a WebSocket to a tmux session via PTY.
 *
 * Uses the `script` command to allocate a pseudo-terminal for `tmux attach`,
 * then bridges stdin/stdout between the spawned process and the WebSocket.
 *
 * Message protocol:
 *   Client -> Server:
 *     - Binary: raw terminal input (keystrokes)
 *     - Text JSON: { type: "resize", cols: number, rows: number }
 *   Server -> Client:
 *     - Binary: raw terminal output (ANSI sequences)
 *     - Text JSON: { type: "connected" } | { type: "error", message: string }
 */

import { spawn, type Subprocess, type ServerWebSocket } from "bun";
import * as tmux from "../infra/tmux.js";

/** Validates that a session name contains only safe characters (alphanumeric, hyphens, underscores). */
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function sanitizeSessionName(name: string): string {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`Invalid session name: contains disallowed characters`);
  }
  return name;
}

export interface TerminalSession {
  proc: Subprocess;
  sessionName: string;
  alive: boolean;
}

const activeSessions = new Map<object, TerminalSession>();

/** Build the command to attach to a tmux session via PTY. */
function buildAttachCommand(sessionName: string): string[] {
  // sessionName MUST be pre-validated via sanitizeSessionName before reaching here
  const tmuxBin = tmux.tmuxBin();
  if (process.platform === "darwin") {
    // macOS: script -q /dev/null <command> [args...]
    return ["script", "-q", "/dev/null", tmuxBin, "attach-session", "-t", sessionName];
  }
  // Linux: script -q -c "<command>" /dev/null
  // sessionName is safe (alphanumeric + hyphens + underscores only) so shell interpolation is safe
  return ["script", "-q", "-c", `${tmuxBin} attach-session -t ${sessionName}`, "/dev/null"];
}

/** Start a terminal bridge for a WebSocket connection. */
export function startTerminalBridge(ws: ServerWebSocket<unknown>, sessionName: string): TerminalSession | null {
  // Validate session name to prevent command injection
  sanitizeSessionName(sessionName);

  if (!tmux.sessionExists(sessionName)) return null;

  const cmd = buildAttachCommand(sessionName);
  const proc = spawn({
    cmd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const session: TerminalSession = { proc, sessionName, alive: true };
  activeSessions.set(ws, session);

  // Stream stdout to WebSocket
  (async () => {
    try {
      const reader = proc.stdout.getReader();
      while (session.alive) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && session.alive) {
          try {
            ws.sendBinary(value);
          } catch {
            break;
          }
        }
      }
    } catch {
      // Process ended or read error
    } finally {
      session.alive = false;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  })();

  // Also drain stderr (don't send to client, just prevent blocking)
  (async () => {
    try {
      const reader = proc.stderr.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      /* ignore */
    }
  })();

  // Detect process exit
  proc.exited.then(() => {
    session.alive = false;
    try {
      ws.send(JSON.stringify({ type: "disconnected" }));
      ws.close();
    } catch {
      /* already closed */
    }
  });

  return session;
}

/** Handle incoming data from WebSocket client. */
export function handleTerminalInput(ws: ServerWebSocket<unknown>, data: string | Buffer | ArrayBuffer): void {
  const session = activeSessions.get(ws);
  if (!session?.alive) return;

  // Check for JSON control messages
  if (typeof data === "string") {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "resize" && msg.cols && msg.rows) {
        handleResize(session.sessionName, msg.cols, msg.rows);
        return;
      }
    } catch {
      // Not JSON -- treat as raw input
    }
    // Raw text input
    const sink = session.proc.stdin as import("bun").FileSink;
    sink.write(data);
    sink.flush();
    return;
  }

  // Binary input
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const sink = session.proc.stdin as import("bun").FileSink;
  sink.write(bytes);
  sink.flush();
}

/** Resize the tmux window. */
function handleResize(sessionName: string, cols: number, rows: number): void {
  try {
    const tmuxBin = tmux.tmuxBin();
    // sessionName was validated at bridge creation; cols/rows are coerced to string digits
    const proc = spawn({
      cmd: [
        tmuxBin,
        "resize-window",
        "-t",
        sessionName,
        "-x",
        String(Math.max(1, cols | 0)),
        "-y",
        String(Math.max(1, rows | 0)),
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    // Consume pipes to prevent resource leaks
    proc.exited.catch(() => {
      /* best-effort */
    });
  } catch {
    /* resize is best-effort */
  }
}

/** Clean up a terminal session when WebSocket closes. */
export function cleanupTerminalBridge(ws: ServerWebSocket<unknown>): void {
  const session = activeSessions.get(ws);
  if (!session) return;

  session.alive = false;
  activeSessions.delete(ws);

  // Kill the script/tmux attach process (this detaches, doesn't kill the tmux session)
  try {
    session.proc.kill();
  } catch {
    /* already dead */
  }
}

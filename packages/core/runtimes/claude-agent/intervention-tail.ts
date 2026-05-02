/**
 * File-tail for agent-sdk mid-session interventions.
 *
 * Reads `<sessionDir>/interventions.jsonl` from position 0, delivering each
 * non-empty line as a parsed `content` string to `onMessage`. Uses `fs.watch`
 * when the file exists at start time; falls back to 200 ms polling until the
 * file appears. JSON parse errors are skipped (logged via `onError`) so a
 * malformed line never kills the agent loop.
 *
 * Returns a `stop()` function. Call it when the agent's result message arrives
 * to stop the tail.
 */

import { existsSync, openSync, readSync, closeSync, statSync, watch as fsWatch } from "fs";
import type { FSWatcher } from "fs";

export interface InterventionTailOpts {
  path: string;
  onMessage: (content: string) => void;
  /**
   * Called when a line with `control: "interrupt"` is detected. The content
   * is also passed to `onMessage` so the correction reaches the prompt queue.
   * The callback should abort the current SDK query iteration.
   */
  onInterrupt?: () => void;
  onError?: (err: Error) => void;
}

export function startInterventionTail(opts: InterventionTailOpts): () => void {
  const { path, onMessage, onInterrupt, onError } = opts;

  let stopped = false;
  let offset = 0;
  let watcher: FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function readNewBytes(): void {
    if (stopped) return;
    if (!existsSync(path)) return;

    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }

    if (size <= offset) return;

    const toRead = size - offset;
    const buf = Buffer.allocUnsafe(toRead);
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return;
    }

    let bytesRead = 0;
    try {
      bytesRead = readSync(fd, buf, 0, toRead, offset);
    } finally {
      closeSync(fd);
    }

    if (bytesRead <= 0) return;
    offset += bytesRead;

    const chunk = buf.slice(0, bytesRead).toString("utf8");
    const lines = chunk.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { content?: unknown; control?: unknown };
        if (typeof parsed.content === "string") {
          onMessage(parsed.content);
        }
        // Fire the interrupt callback after pushing the content so the
        // correction is already in the queue when the abort fires.
        if (parsed.control === "interrupt" && onInterrupt) {
          onInterrupt();
        }
      } catch (err) {
        if (onError) onError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  function attachWatcher(): void {
    if (stopped) return;
    try {
      watcher = fsWatch(path, () => {
        readNewBytes();
      });
      watcher.on("error", (err) => {
        if (onError) onError(err);
      });
      // Drain anything written before the watcher attached.
      readNewBytes();
    } catch (err) {
      if (onError) onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  if (existsSync(path)) {
    // File already present -- read any pre-existing content, then watch.
    readNewBytes();
    attachWatcher();
  } else {
    // Poll at 200 ms until the file appears, then switch to watcher.
    pollTimer = setInterval(() => {
      if (stopped) {
        if (pollTimer !== null) clearInterval(pollTimer);
        pollTimer = null;
        return;
      }
      if (existsSync(path)) {
        if (pollTimer !== null) clearInterval(pollTimer);
        pollTimer = null;
        readNewBytes();
        attachWatcher();
      }
    }, 200);
  }

  return function stop(): void {
    stopped = true;
    if (watcher !== null) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
      watcher = null;
    }
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
}

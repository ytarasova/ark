/**
 * Stream-JSON output parser for goose (and similar CLI agents).
 *
 * Goose emits `--output-format stream-json` lines to stdout. Each line is a
 * JSON object like:
 *
 *   {"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
 *
 * This module extracts assistant text content from the stream and stores it
 * as chat messages via app.messages.send(), making them visible in the web
 * ChatPanel instead of requiring users to read raw JSON in the terminal.
 *
 * Integrated into the status poller -- every tick it captures new tmux output,
 * parses any new JSON lines, and persists extracted messages.
 */

import type { AppContext } from "../app.js";
import * as tmux from "../infra/tmux.js";

// Track how many lines we've already processed per session to avoid duplicates.
const cursors = new Map<string, number>();

/**
 * Capture tmux output, parse stream-json lines, and store new assistant
 * messages. Safe to call repeatedly -- tracks a cursor to skip already-parsed
 * lines.
 */
export async function parseStreamJsonOutput(app: AppContext, sessionId: string, handle: string): Promise<void> {
  const raw = await tmux.capturePaneAsync(handle, { lines: 2000 });
  if (!raw) return;

  const lines = raw.split("\n");
  const cursor = cursors.get(sessionId) ?? 0;

  // Only process new lines since last tick
  const newLines = lines.slice(cursor);
  if (newLines.length === 0) return;

  for (const line of newLines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    try {
      const obj = JSON.parse(trimmed);
      if (obj.type !== "message") continue;

      const msg = obj.message;
      if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

      // Extract text blocks from the assistant message
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          app.messages.send(sessionId, "agent", block.text, "text");
        }
      }
    } catch {
      // Not valid JSON or unexpected shape -- skip
    }
  }

  cursors.set(sessionId, lines.length);
}

/** Clean up cursor state when a session ends. */
export function clearStreamJsonCursor(sessionId: string): void {
  cursors.delete(sessionId);
}

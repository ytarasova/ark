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
 * Tmux wraps long lines at the terminal width (~220 chars), so a single JSON
 * object often spans multiple captured lines. We reassemble them by tracking
 * brace depth before attempting JSON.parse.
 *
 * Integrated into the status poller -- every tick it captures new tmux output,
 * parses any new JSON lines, and persists extracted messages.
 */

import type { AppContext } from "../app.js";
import * as tmux from "../infra/tmux.js";

// Track how many lines we've already processed per session to avoid duplicates.
const cursors = new Map<string, number>();

// Track message content hashes to avoid duplicate messages across ticks.
// Tmux capture returns the full scrollback each time, and cursor tracking by
// line count can drift when the terminal reflows. Dedup by content hash.
const seenHashes = new Map<string, Set<string>>();

function contentHash(role: string, text: string): string {
  // Use first 200 chars + length as a cheap fingerprint
  return `${role}:${text.length}:${text.slice(0, 200)}`;
}

/**
 * Reassemble JSON objects from tmux-wrapped lines.
 *
 * Tmux wraps at terminal width, splitting `{"type":"message",...}` across
 * multiple lines. We scan for lines starting with `{`, then accumulate
 * continuation lines until brace depth returns to zero.
 */
function reassembleJsonLines(lines: string[]): string[] {
  const results: string[] = [];
  let buffer = "";
  let depth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (depth === 0) {
      // Looking for the start of a new JSON object
      if (!trimmed.startsWith("{")) continue;
      buffer = trimmed;
      depth = countBraceDepth(trimmed);
      if (depth === 0) {
        // Complete object on one line
        results.push(buffer);
        buffer = "";
      }
    } else {
      // Continuation of a wrapped JSON line
      buffer += trimmed;
      depth += countBraceDepth(trimmed);
      if (depth <= 0) {
        results.push(buffer);
        buffer = "";
        depth = 0;
      }
    }
  }

  return results;
}

/** Count net brace depth change, ignoring braces inside JSON strings. */
function countBraceDepth(s: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth;
}

/**
 * Capture tmux output, parse stream-json lines, and store new assistant
 * messages. Safe to call repeatedly -- tracks a cursor to skip already-parsed
 * lines and deduplicates by content hash.
 */
export async function parseStreamJsonOutput(app: AppContext, sessionId: string, handle: string): Promise<void> {
  const raw = await tmux.capturePaneAsync(handle, { lines: 2000 });
  if (!raw) return;

  const lines = raw.split("\n");
  const cursor = cursors.get(sessionId) ?? 0;

  // Only process new lines since last tick
  const newLines = lines.slice(cursor);
  if (newLines.length === 0) return;

  // Reassemble wrapped JSON objects
  const jsonObjects = reassembleJsonLines(newLines);

  // Get or create the dedup set for this session
  if (!seenHashes.has(sessionId)) {
    seenHashes.set(sessionId, new Set());
  }
  const seen = seenHashes.get(sessionId)!;

  for (const jsonStr of jsonObjects) {
    try {
      const obj = JSON.parse(jsonStr);
      if (obj.type !== "message") continue;

      const msg = obj.message;
      if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

      // Extract text blocks from the assistant message
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          const hash = contentHash("agent", block.text);
          if (seen.has(hash)) continue;
          seen.add(hash);
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
  seenHashes.delete(sessionId);
}

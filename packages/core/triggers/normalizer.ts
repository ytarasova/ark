/**
 * Shared normalization helpers for trigger sources.
 *
 * Most per-source connectors end up writing small shape-specific mappers,
 * but a handful of operations are reusable -- JSON parsing with a friendly
 * error, JSONPath lookup, safe timing-equal comparisons, and building the
 * canonical NormalizedEvent envelope.
 */

import type { NormalizedEvent } from "./types.js";
import { timingSafeEqual as nodeTimingSafeEqual } from "crypto";

// ── JSON parse with envelope ─────────────────────────────────────────────────

/**
 * Parse request body as JSON, throwing SyntaxError on malformed input. The
 * webhook handler converts this into a 400 response.
 */
export function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new SyntaxError(`invalid JSON body: ${(e as Error).message ?? e}`);
  }
}

/**
 * Build a NormalizedEvent with `receivedAt` already stamped. Keeps per-source
 * mappers terse -- they pass in the fields they care about.
 */
export function buildEvent(opts: {
  source: string;
  event: string;
  payload: unknown;
  ref?: string;
  actor?: NormalizedEvent["actor"];
  sourceMeta?: Record<string, unknown>;
  receivedAt?: number;
}): NormalizedEvent {
  return {
    source: opts.source,
    event: opts.event,
    payload: opts.payload,
    ref: opts.ref,
    actor: opts.actor,
    sourceMeta: opts.sourceMeta,
    receivedAt: opts.receivedAt ?? Date.now(),
  };
}

// ── JSONPath (tiny dotted-path subset) ───────────────────────────────────────

/**
 * Minimal JSONPath-style lookup. Supports:
 *   - `$`           : the event root { source, event, ref, actor, payload, ... }
 *   - `$.a.b.c`     : dotted traversal
 *   - `$.a[0].b`    : array index
 *   - `$.payload.x` : payload access
 *
 * Falls back to undefined for missing keys. Does NOT support filter
 * expressions or wildcards -- callers wanting richer selection should
 * compose this with extra logic.
 *
 * If the expression does not start with `$`, the value is returned verbatim.
 */
export function evalJsonPath(expr: string, root: NormalizedEvent): unknown {
  if (!expr) return undefined;
  if (!expr.startsWith("$")) return expr; // literal
  const cursorRoot: Record<string, unknown> = {
    source: root.source,
    event: root.event,
    ref: root.ref,
    actor: root.actor,
    payload: root.payload,
    sourceMeta: root.sourceMeta,
    receivedAt: root.receivedAt,
  };
  let cursor: unknown = cursorRoot;
  const path = expr.slice(1);
  if (path === "" || path === ".") return cursor;

  const tokens = tokenizePath(path);
  for (const t of tokens) {
    if (cursor == null) return undefined;
    if (t.startsWith("[")) {
      const idx = Number(t.slice(1, -1));
      if (!Array.isArray(cursor) || Number.isNaN(idx)) return undefined;
      cursor = cursor[idx];
    } else {
      if (typeof cursor !== "object") return undefined;
      cursor = (cursor as Record<string, unknown>)[t];
    }
  }
  return cursor;
}

function tokenizePath(path: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inBracket = false;
  for (const ch of path) {
    if (ch === "[") {
      if (buf) out.push(buf);
      buf = "";
      inBracket = true;
      continue;
    }
    if (ch === "]") {
      if (buf) out.push(`[${buf}]`);
      buf = "";
      inBracket = false;
      continue;
    }
    if (ch === "." && !inBracket) {
      if (buf) out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Render a template string -- replaces `$.a.b` placeholders with their
 * JSONPath-resolved value. Returns the string as-is if it contains no
 * `$` characters. Used for `summary` / `repo` trigger-config fields.
 */
export function renderTemplate(template: string, event: NormalizedEvent): string {
  if (!template.includes("$")) return template;
  return template.replace(/\$(\.[a-zA-Z_][a-zA-Z0-9_.[\]]*)/g, (_match, path: string) => {
    const v = evalJsonPath(`$${path}`, event);
    return v === undefined || v === null ? "" : String(v);
  });
}

// ── Timing-safe equal ────────────────────────────────────────────────────────

/**
 * Constant-time string compare for signature verification. Returns false on
 * length mismatch (no oracle) and never throws.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) {
    const pad = Buffer.alloc(ab.length, 0);
    try {
      nodeTimingSafeEqual(ab, pad);
    } catch {
      /* keep timing uniform on length mismatch */
    }
    return false;
  }
  return nodeTimingSafeEqual(ab, bb);
}

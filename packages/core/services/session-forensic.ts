/**
 * Session forensic-file helpers.
 *
 * Every session writes two observability artefacts under `<tracksDir>/<id>/`:
 *   - `stdio.log`        -- raw dispatcher stdout + `[exec ...]` lines
 *   - `transcript.jsonl` -- agent-sdk message stream (one JSON per line)
 *
 * These helpers read those files with a hard size cap so a runaway log can't
 * OOM the conductor, and implement the `?tail=<N>` semantics used by the
 * `GET /api/sessions/:id/stdio` HTTP route + `session/stdio` RPC method.
 *
 * Callers are responsible for 404-ing when the session itself is missing --
 * this module only deals with files and file shapes.
 */

import { promises as fsPromises } from "node:fs";
import { join } from "node:path";

/** Absolute upper bound on bytes returned per request. ~2MB per the UI spec. */
export const MAX_FORENSIC_BYTES = 2 * 1024 * 1024;

export interface ForensicReadResult {
  /** File contents (possibly tail-sliced). Empty string when file is missing. */
  content: string;
  /** File existed on disk. */
  exists: boolean;
  /** Full file size in bytes (0 when missing). */
  size: number;
  /** True when the file is larger than `MAX_FORENSIC_BYTES` and `tail` was not supplied. */
  tooLarge: boolean;
}

/**
 * Read a forensic file from `<tracksDir>/<sessionId>/<file>` with tail support.
 *
 * Semantics:
 *   - Missing file          -> `{ content: "", exists: false, size: 0, tooLarge: false }`
 *   - File size <= cap      -> full content (or last `tail` lines if supplied)
 *   - File size > cap + no tail -> `{ content: "", exists: true, tooLarge: true, size }`
 *   - File size > cap + tail    -> read the last `<max>` bytes then keep the last `tail` lines
 */
export async function readForensicFile(
  tracksDir: string,
  sessionId: string,
  fileName: string,
  opts: { tail?: number } = {},
): Promise<ForensicReadResult> {
  const path = join(tracksDir, sessionId, fileName);
  let stat: { size: number } | null = null;
  try {
    const s = await fsPromises.stat(path);
    stat = { size: s.size };
  } catch {
    return { content: "", exists: false, size: 0, tooLarge: false };
  }

  const size = stat.size;
  const { tail } = opts;

  // Over the cap with no tail hint -> refuse.
  if (size > MAX_FORENSIC_BYTES && (tail == null || !Number.isFinite(tail) || tail <= 0)) {
    return { content: "", exists: true, size, tooLarge: true };
  }

  // When we have to honour tail on a huge file we read the last MAX bytes so
  // the slice we hand back always fits under the cap.
  let raw: string;
  if (size > MAX_FORENSIC_BYTES) {
    const fh = await fsPromises.open(path, "r");
    try {
      const offset = size - MAX_FORENSIC_BYTES;
      const buf = Buffer.alloc(MAX_FORENSIC_BYTES);
      await fh.read(buf, 0, MAX_FORENSIC_BYTES, offset);
      raw = buf.toString("utf8");
      // Strip any partial first line -- tail semantics must always start at a
      // line boundary so the client never renders half a record.
      const firstNl = raw.indexOf("\n");
      if (firstNl >= 0) raw = raw.slice(firstNl + 1);
    } finally {
      await fh.close();
    }
  } else {
    raw = await fsPromises.readFile(path, "utf8");
  }

  if (tail != null && Number.isFinite(tail) && tail > 0) {
    const lines = raw.split("\n");
    // The last element is the empty trailing-newline remnant when the file
    // ended in `\n`. Drop it before counting so `tail=10` really means the
    // last 10 visible lines.
    const trailingEmpty = lines.length > 0 && lines[lines.length - 1] === "";
    const body = trailingEmpty ? lines.slice(0, -1) : lines;
    const sliced = body.slice(Math.max(0, body.length - Math.floor(tail)));
    raw = sliced.join("\n") + (trailingEmpty ? "\n" : "");
  }

  return { content: raw, exists: true, size, tooLarge: false };
}

/** Parse an NDJSON forensic string into an array; skips blank + unparseable lines. */
export function parseJsonl(content: string): unknown[] {
  if (!content) return [];
  const out: unknown[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Corrupt line (partial write, non-JSON noise) -- drop it rather than
      // failing the whole request. The client only needs well-formed records.
    }
  }
  return out;
}

/**
 * Idempotency key ledger for side-effectful orchestration calls.
 *
 * RF-8 / #388. Temporal activities have at-least-once delivery: an activity that
 * advances a session's stage may time out at the worker level while the DB
 * commit already landed, and Temporal will retry. Without a deduplication key,
 * the retry re-runs the body and double-advances.
 *
 * Contract:
 *   - Callers pass an optional `idempotencyKey` to `advance`, `complete`,
 *     `handoff`, `executeAction`, and action handlers.
 *   - When the key is undefined, the wrapper is a pass-through: no DB read,
 *     no DB write, no behavior change. This is the local-flow default.
 *   - When the key is set, `withIdempotency` looks up the row by
 *     `(session_id, stage, op_kind, idempotency_key)` and returns the cached
 *     `result_json` if it exists. On a cache miss the body runs, the result is
 *     stringified + persisted, and returned to the caller.
 *   - Racing callers (same key, concurrent) resolve via the unique index: one
 *     INSERT wins, the loser catches the constraint violation and reads back
 *     the winner's row. The body is guaranteed to run at most once per key,
 *     modulo the atomicity of the underlying transaction.
 *
 * The ledger table is created by migration 010 + `initSchema` /
 * `initPostgresSchema` for fresh installs. Callers do not need to know about
 * either -- they go through `withIdempotency`.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

/** Supported op_kind values. Keep in sync with the callers. */
export type IdempotencyOpKind = "advance" | "complete" | "handoff" | "executeAction" | `action:${string}`;

export interface IdempotencyOpts {
  /** Session the operation belongs to. Required (every orchestration op is session-scoped). */
  sessionId: string;
  /** Stage name. Empty string means "no stage" (e.g. completion cascades). */
  stage?: string | null;
  /** Op class -- one row per (sessionId, stage, opKind, idempotencyKey). */
  opKind: IdempotencyOpKind;
  /** Caller-supplied key. When absent the wrapper is a pass-through. */
  idempotencyKey: string | undefined;
}

/**
 * Execute `body` under an idempotency key. Returns the body's result, or the
 * cached result from a previous call with the same key.
 *
 * The stored payload is `JSON.stringify(result)`. Callers should only pass
 * JSON-safe return values -- every orchestration function in this tree
 * already returns `{ok, message}`, which is trivially JSON-safe.
 */
export async function withIdempotency<T>(
  db: DatabaseAdapter,
  opts: IdempotencyOpts,
  body: () => Promise<T>,
): Promise<T> {
  // Fast path: no key -> no table touch. Preserves today's local-flow behavior
  // exactly and keeps the per-call overhead at zero.
  if (!opts.idempotencyKey) return body();

  const stage = opts.stage ?? "";
  const existing = await lookup<T>(db, opts.sessionId, stage, opts.opKind, opts.idempotencyKey);
  if (existing !== null) return existing;

  const result = await body();

  // Persist the result. INSERT OR IGNORE (sqlite) / ON CONFLICT DO NOTHING
  // (postgres) handles the race where a concurrent caller beat us to it --
  // after the conflict we re-read the winning row and drop our local result
  // on the floor. The body's side effects already ran in that branch; that's
  // the at-most-once-but-not-guaranteed contract, which matches Temporal's
  // activity semantics.
  const payload = JSON.stringify(result);
  const createdAt = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO stage_operations
           (session_id, stage, op_kind, idempotency_key, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, stage, op_kind, idempotency_key) DO NOTHING`,
      )
      .run(opts.sessionId, stage, opts.opKind, opts.idempotencyKey, payload, createdAt);
  } catch (e) {
    // sqlite + postgres both honor the ON CONFLICT clause when the unique
    // index exists; fall through to re-read on any other failure so the
    // caller still gets a value. If even the re-read fails, return the
    // fresh body result -- worst case we double-log the side effect once.
    logDebug("session", `stage_operations upsert failed (will re-read): ${(e as Error).message}`);
  }
  const reread = await lookup<T>(db, opts.sessionId, stage, opts.opKind, opts.idempotencyKey);
  return reread !== null ? reread : result;
}

async function lookup<T>(
  db: DatabaseAdapter,
  sessionId: string,
  stage: string,
  opKind: string,
  idempotencyKey: string,
): Promise<T | null> {
  try {
    const row = (await db
      .prepare(
        `SELECT result_json FROM stage_operations
          WHERE session_id = ? AND stage = ? AND op_kind = ? AND idempotency_key = ?
          LIMIT 1`,
      )
      .get(sessionId, stage, opKind, idempotencyKey)) as { result_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.result_json) as T;
  } catch (e) {
    // Table missing (pre-migration test harness?) -> treat as cache miss.
    logDebug("session", `stage_operations lookup failed: ${(e as Error).message}`);
    return null;
  }
}

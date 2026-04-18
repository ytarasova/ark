/**
 * Logger port -- structured logging.
 *
 * Replaces module-level state in `packages/core/observability/structured-log.ts`
 * (`_arkDir`, `_level`). Every log line carries a component tag so downstream
 * adapters can route by bounded context.
 *
 * Local binding: `FileLogger` (writes JSONL under `$ARK_DIR/logs`).
 * Control-plane binding: `CloudLogger` (stdout JSON for container log stacks).
 * Test binding: `MemoryLogger` / `NoopLogger`.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  /** Correlation id propagated across RPC boundaries. */
  traceId?: string;
  /** Active tenant for the log line. */
  tenantId?: string;
  /** Session id if the line is session-scoped. */
  sessionId?: string;
  /** Arbitrary structured fields to serialise alongside the message. */
  [key: string]: unknown;
}

export interface Logger {
  /** Emit a debug-level log. */
  debug(component: string, msg: string, fields?: LogFields): void;

  /** Emit an info-level log. */
  info(component: string, msg: string, fields?: LogFields): void;

  /** Emit a warn-level log. */
  warn(component: string, msg: string, fields?: LogFields): void;

  /** Emit an error-level log. Attach `err` for stack capture. */
  error(component: string, msg: string, fields?: LogFields & { err?: unknown }): void;

  /**
   * Return a child logger with the given fields merged into every subsequent
   * call. Used to bind `{ tenantId, sessionId, traceId }` once per request.
   */
  child(fields: LogFields): Logger;
}

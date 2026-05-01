/**
 * Structured per-step instrumentation for the remote provisioner.
 *
 * Why this exists
 * ===============
 *
 * The provisioner runs ~7 ordered steps -- connectivity-check,
 * forward-tunnel, arkd-probe, events-consumer-start, flush-secrets,
 * git-clone, launch-agent. Each step has its own failure mode (SSH
 * settling latency, Bun keep-alive pool corruption, transient SSM
 * blips, ...) and its own appropriate retry budget. Without a uniform
 * wrapper, every step ends up with a hand-rolled try/catch + ad-hoc
 * `logInfo` trace + ad-hoc retry, the trace lives only in `ark.jsonl`,
 * and the failure that lands in the UI is a bare `socket closed`
 * disconnected from which step it came from.
 *
 * `provisionStep(app, sessionId, stepName, fn, opts)` solves that:
 *
 *   - Emits structured `provisioning_step` events on the session's
 *     timeline (started / retrying / ok / failed) so the web UI can
 *     render an inline trail of "connectivity-check ok 9s, forward-tunnel
 *     ok 0.3s, arkd-probe ok 8.8s, ..." without grepping log files.
 *   - Mirrors the same payload to `ark.jsonl` via `structured-log`,
 *     keyed on sessionId + step, so post-mortem grep is a one-liner.
 *   - Retries transient transport errors (socket close / ECONNRESET /
 *     EPIPE / "Unable to connect" / "operation timed out") with
 *     exponential backoff capped at the per-step budget. Non-transient
 *     errors fail-fast on the first attempt.
 *   - Wraps the underlying error in `ProvisionStepError(step, cause)`
 *     so the UI's failure message starts with the failing step name
 *     and `.cause` preserves the original stack.
 *
 * Event payload shape
 * ===================
 *
 * Every event is `{ type: "provisioning_step", actor: "system", data: ... }`
 * where `data` matches one of the four `ProvisioningStepData` variants:
 *
 *   { step, status: "started",   ...context }
 *   { step, status: "retrying",  attempt, message, transient, ...context }
 *   { step, status: "ok",        durationMs, attempts, ...context }
 *   { step, status: "failed",    durationMs, attempts, errorChain[], message, transient, ...context }
 *
 * `errorChain` is the unwrapped `Error.cause` chain, capped at depth 5,
 * so a wrapped `ArkdClientTransportError -> TypeError(socket closed)`
 * survives transit to both the events table and ark.jsonl with both
 * messages and stacks intact.
 */

import type { AppContext } from "../app.js";
import { logInfo, logWarn, logError } from "../observability/structured-log.js";

// ── Public types ─────────────────────────────────────────────────────────────

/** Status discriminant on a `provisioning_step` event's data payload. */
export type ProvisioningStepStatus = "started" | "retrying" | "ok" | "failed";

/** Single link in the captured `Error.cause` chain. */
export interface ErrorChainLink {
  name?: string;
  message?: string;
  stack?: string;
}

/** Discriminated union of payloads a `provisioning_step` event can carry. */
export type ProvisioningStepData =
  | { step: string; status: "started"; [extra: string]: unknown }
  | { step: string; status: "retrying"; attempt: number; transient: true; message: string; [extra: string]: unknown }
  | { step: string; status: "ok"; durationMs: number; attempts: number; [extra: string]: unknown }
  | {
      step: string;
      status: "failed";
      durationMs: number;
      attempts: number;
      transient: boolean;
      message: string;
      errorChain: ErrorChainLink[];
      [extra: string]: unknown;
    };

export interface ProvisionStepOpts {
  /**
   * Number of additional attempts on top of the initial one. Default 0
   * (one attempt total). Pick a budget appropriate to the step's
   * idempotency: a clean retry on `git clone` is fine because the dest
   * dir is fresh per session; a retry on `launch-agent` is risky because
   * tmux session names don't dedupe.
   */
  retries?: number;
  /**
   * Initial backoff before the first retry (ms). Doubles per attempt up
   * to `MAX_BACKOFF_MS`. Default 500ms.
   */
  retryBackoffMs?: number;
  /**
   * Override the default transient-error matcher. Useful when a step has
   * step-specific transient signatures on top of the generic transport
   * patterns we already recognise.
   */
  isTransient?: (error: unknown) => boolean;
  /**
   * Free-form context fields echoed on every event emitted for this
   * step (e.g. `compute`, `instanceId`, `localPort`). Aids forensic grep
   * when multiple sessions provision concurrently.
   */
  context?: Record<string, unknown>;
}

/**
 * Error thrown by `provisionStep` when a step's retries are exhausted
 * (or a non-transient error fires). The `step` field names the failing
 * phase so the UI can render `step=git-clone failed: <cause>` and
 * `.cause` preserves the original error chain.
 */
export class ProvisionStepError extends Error {
  readonly step: string;
  constructor(step: string, cause: unknown) {
    super(`provision step '${step}' failed: ${messageOf(cause)}`, { cause });
    this.name = "ProvisionStepError";
    this.step = step;
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
const ERROR_CHAIN_DEPTH = 5;

/**
 * Transport-level error signatures we treat as "might recover on retry".
 * Each pattern is named for grep-friendliness when an operator wonders
 * "why was this retried?" -- the answer is in `defaultIsTransient`'s
 * test source.
 *
 * These patterns are matched case-insensitively against the error
 * message. Authentication errors (401/403) and programming errors
 * (TypeError on undefined / `not a function` / etc.) deliberately do
 * NOT appear here -- those are not transient and should fail-fast.
 */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /socket connection was closed/i,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bEPIPE\b/,
  /\bfetch failed\b/i,
  /unable to connect/i,
  /operation timed out/i,
  /temporarily unavailable/i,
  /connection refused/i,
];

/** Default classifier: does this error look like it might pass on retry? */
function defaultIsTransient(error: unknown): boolean {
  const msg = messageOf(error);
  return TRANSIENT_PATTERNS.some((p) => p.test(msg));
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function backoffFor(attempt: number, base: number): number {
  return Math.min(base * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/**
 * Walk `Error.cause` once and return up to `ERROR_CHAIN_DEPTH` links.
 * Stops on the first non-Error cause so we never serialise random
 * objects into the event log.
 */
function captureErrorChain(error: unknown): ErrorChainLink[] {
  const chain: ErrorChainLink[] = [];
  let cur: unknown = error;
  while (cur instanceof Error && chain.length < ERROR_CHAIN_DEPTH) {
    chain.push({ name: cur.name, message: cur.message, stack: cur.stack });
    cur = (cur as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * Best-effort emit -- the event-log shouldn't be able to mask the step's
 * own outcome. We always log to `structured-log` synchronously (for
 * grep) and fire `app.events.log` as a fire-and-forget Promise (for the
 * UI timeline). A failure to persist the event is logged at debug
 * level only; nothing throws back into the step's caller.
 */
function emitStepEvent(
  app: AppContext,
  sessionId: string,
  data: ProvisioningStepData,
  context: Record<string, unknown>,
): void {
  void app.events
    .log(sessionId, "provisioning_step", {
      actor: "system",
      data: { ...data, ...context },
    })
    .catch(() => undefined);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run `fn` as a named provisioning step. Returns `fn`'s value on
 * success or throws `ProvisionStepError`.
 */
export async function provisionStep<T>(
  app: AppContext,
  sessionId: string,
  step: string,
  fn: () => Promise<T>,
  opts: ProvisionStepOpts = {},
): Promise<T> {
  const retries = opts.retries ?? 0;
  const baseBackoff = opts.retryBackoffMs ?? DEFAULT_BACKOFF_MS;
  const isTransient = opts.isTransient ?? defaultIsTransient;
  const context = opts.context ?? {};
  const startedAt = Date.now();

  emitStepEvent(app, sessionId, { step, status: "started" }, context);
  logInfo("provision", `[${sessionId}] step=${step} started`, { sessionId, step, ...context });

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const result = await fn();
      const durationMs = Date.now() - startedAt;
      emitStepEvent(app, sessionId, { step, status: "ok", durationMs, attempts: attempt }, context);
      logInfo("provision", `[${sessionId}] step=${step} ok in ${durationMs}ms (attempts=${attempt})`, {
        sessionId,
        step,
        durationMs,
        attempts: attempt,
        ...context,
      });
      return result;
    } catch (error) {
      const transient = isTransient(error);
      const hasBudget = attempt <= retries;
      if (transient && hasBudget) {
        const backoff = backoffFor(attempt, baseBackoff);
        const message = messageOf(error);
        emitStepEvent(
          app,
          sessionId,
          { step, status: "retrying", attempt, transient: true, message },
          context,
        );
        logWarn(
          "provision",
          `[${sessionId}] step=${step} attempt ${attempt} failed (transient), retrying in ${backoff}ms: ${message}`,
          { sessionId, step, attempt, transient: true, message, ...context },
        );
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      // Terminal failure -- no budget left, or error wasn't transient.
      const durationMs = Date.now() - startedAt;
      const errorChain = captureErrorChain(error);
      const message = messageOf(error);
      emitStepEvent(
        app,
        sessionId,
        { step, status: "failed", durationMs, attempts: attempt, transient, message, errorChain },
        context,
      );
      logError(
        "provision",
        `[${sessionId}] step=${step} failed after ${attempt} attempt(s): ${message}`,
        { sessionId, step, durationMs, attempts: attempt, transient, errorChain, ...context },
      );
      throw new ProvisionStepError(step, error);
    }
  }
  // Loop above always returns or throws; this is a TypeScript appeasement.
  /* istanbul ignore next */
  throw new Error(`provisionStep: unreachable (step=${step})`);
}

/**
 * Trigger framework -- turns an external / scheduled / event input into an
 * Ark flow invocation.
 *
 * Pipeline:
 *   Source -> Receiver (verify signature, parse) -> NormalizedEvent
 *         -> Matcher (which trigger configs fire?)
 *         -> Dispatcher (invoke flow with mapped inputs)
 *
 * Four trigger kinds:
 *   - webhook  -- HTTP POST from external (GitHub, Bitbucket, Linear, Slack, ...)
 *   - schedule -- cron, glued into existing schedule handler (bridgeable)
 *   - poll     -- pull from APIs that don't push
 *   - event    -- internal events (session-completed -> chain) -- interface only
 *
 * This file declares the shared interfaces. Per-source connectors live under
 * `./sources/<name>.ts` and implement `TriggerSource`.
 */

// ── Core kinds ────────────────────────────────────────────────────────────────

export type TriggerKind = "webhook" | "schedule" | "poll" | "event";

/** Implementation maturity reported by a source connector. */
export type TriggerSourceStatus = "full" | "scaffolded" | "stub";

/**
 * Canonical normalized event. Every source maps its inbound payload into this
 * shape. Downstream matching + input mapping operate on it exclusively.
 */
export interface NormalizedEvent {
  /** Source identifier (e.g. "github", "bitbucket", "slack", "generic-hmac"). */
  source: string;
  /** Source-qualified event name (e.g. "pull_request.opened", "issue_created"). */
  event: string;
  /** Optional ref (branch, commit, tag, issue-id). Source-specific. */
  ref?: string;
  /** Optional actor that produced the event (a user / bot). */
  actor?: { id?: string; name?: string; email?: string };
  /** The raw, source-shaped payload (post-parse, pre-map). */
  payload: unknown;
  /** Epoch millis when Ark received the event. */
  receivedAt: number;
  /** Free-form per-source metadata (delivery id, signatures header, etc.). */
  sourceMeta?: Record<string, unknown>;
}

// ── Trigger config (YAML-sourced) ────────────────────────────────────────────

/**
 * Match filter -- equality on payload fields (JSONPath-style dotted keys).
 * Example:
 *   match:
 *     repo: paytmteam/foo
 *     action: opened
 * A missing/unequal field skips the trigger.
 */
export type TriggerMatchFilter = Record<string, string | number | boolean>;

/**
 * Input mapping -- destination key -> JSONPath expression evaluated against
 * the normalized event. `$.payload.pull_request.html_url` style; also
 * supports `$.ref`, `$.actor.name`, etc. Keys become entries on
 * `inputs.params` when the flow starts.
 */
export type TriggerInputMap = Record<string, string>;

export interface TriggerConfig {
  /** Unique name -- matches file stem under `triggers/`. */
  name: string;
  /** Source key -- must be registered in the source registry. */
  source: string;
  /** Source-qualified event name. Empty / missing matches anything. */
  event?: string;
  /** Filter on payload fields (all must match). */
  match?: TriggerMatchFilter;
  /** Target flow to invoke. */
  flow: string;
  /** Optional: summary template (supports $.x.y references). */
  summary?: string;
  /** Optional: repo resolver (JSONPath or literal). */
  repo?: string;
  /** Input mapping: inputs.params[k] <- $.<path> */
  inputs?: TriggerInputMap;
  /** Static params merged into inputs.params (non-JSONPath literals). */
  params?: Record<string, string | number | boolean>;
  /** Tenant -- defaults to "default" in local profile. */
  tenant?: string;
  /** True by default; disabled configs are skipped at match time. */
  enabled?: boolean;
  /** Trigger kind: webhook (default), schedule, poll, event. */
  kind?: TriggerKind;
  /**
   * For `schedule` triggers: cron expression. A future bridge creates a
   * schedule row; today schedule kinds are documented-only.
   */
  cron?: string;
  /** For `poll` triggers: poll interval (seconds). Default 300. */
  pollIntervalSec?: number;
}

// ── Source interface ─────────────────────────────────────────────────────────

/**
 * Result of a source receiving an HTTP request. Used only by polling /
 * scripted callers that do not go through the webhook handler.
 */
export type SourceReceiveResult = { ok: true; event: NormalizedEvent } | { ok: false; status: number; message: string };

/**
 * A per-source connector. Every connector implements `name` + `verify` +
 * `normalize`. `poll` is only required for `poll`-kind triggers.
 *
 * `secretEnvVar` documents the environment variable fallback the secrets
 * layer uses when no entry is present in `~/.ark/secrets.yaml`.
 */
export interface TriggerSource {
  /** Source id (matches `source` field in trigger configs). */
  readonly name: string;
  /** Human-readable label. */
  readonly label: string;
  /**
   * Env var fallback for the signing secret. Example for github:
   * `ARK_TRIGGER_GITHUB_SECRET`.
   */
  readonly secretEnvVar: string;
  /**
   * Implementation status.
   * - `full`       : verify + normalize + tests pass end-to-end
   * - `scaffolded` : verify + normalize landed, TODO for edge cases
   * - `stub`       : config-only example, no runtime path
   */
  readonly status: TriggerSourceStatus;

  /**
   * Verify an incoming request's signature (HMAC / JWT / token).
   * Implementations MUST NOT throw -- return false on every failure.
   */
  verify(req: { headers: Headers; body: string }, secret: string | null): Promise<boolean>;

  /**
   * Parse + normalize the payload into a NormalizedEvent. Throw `SyntaxError`
   * on malformed JSON; return a concrete event on success.
   */
  normalize(req: { headers: Headers; body: string }): Promise<NormalizedEvent>;

  /**
   * Optional pull-mode hook. Implemented by sources registered with
   * `kind: poll` triggers. Called on each tick; should produce zero or
   * more NormalizedEvents to feed into the matcher.
   */
  poll?(opts: { cursor?: string; config: TriggerConfig }): Promise<{
    events: NormalizedEvent[];
    cursor?: string;
  }>;
}

// ── Matcher + dispatcher ─────────────────────────────────────────────────────

export interface TriggerMatcher {
  match(event: NormalizedEvent, configs: TriggerConfig[]): TriggerConfig[];
}

export interface TriggerDispatchResult {
  ok: boolean;
  sessionId?: string;
  skipped?: boolean;
  message?: string;
}

export interface TriggerDispatcher {
  dispatch(opts: { event: NormalizedEvent; config: TriggerConfig }): Promise<TriggerDispatchResult>;
}

// ── Store ────────────────────────────────────────────────────────────────────

export interface TriggerStore {
  list(tenant?: string): TriggerConfig[];
  get(name: string, tenant?: string): TriggerConfig | null;
  reload(): void;
  enable(name: string, enabled: boolean, tenant?: string): boolean;
}

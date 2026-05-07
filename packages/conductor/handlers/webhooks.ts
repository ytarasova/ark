/**
 * HTTP webhook receiver for the trigger framework.
 *
 * Exported entry point: `handleWebhookRequest(app, req)`. The hosted web
 * server dispatches to this function for any request matching
 * `POST /api/webhooks/:source` or `POST /webhooks/:source`.
 *
 * Pipeline (always runs in this order):
 *
 *   1. Resolve source from URL (`/webhooks/github` -> `github`). Unknown
 *      source -> 404.
 *   2. Resolve per-tenant signing secret. Missing secret -> 401 (never a
 *      silent pass -- there is no insecure default).
 *   3. Call source.verify(req, secret). Invalid signature -> 401.
 *   4. Call source.normalize(req). Malformed payload -> 400.
 *   5. Slack-specific: if payload is `url_verification`, echo the challenge
 *      verbatim (200 text/plain).
 *   6. Match event against loaded trigger configs. Zero matches -> 202
 *      "no matching triggers" (still 2xx -- the deliver is valid).
 *   7. Enqueue dispatch of each matched trigger as a microtask and return
 *      202 Accepted immediately. Dispatch never blocks the HTTP response.
 *
 * Failure modes return JSON: { ok: false, error, code } so callers can
 * debug via curl.
 */

import type { AppContext } from "../../core/app.js";
import {
  createFileTriggerStore,
  DefaultTriggerDispatcher,
  defaultMatcher,
  createDefaultRegistry,
  resolveSecret,
  type FileTriggerStore,
  type NormalizedEvent,
  type TriggerSource,
  type TriggerSourceRegistry,
} from "../../core/triggers/index.js";
import { resolveStoreBaseDir } from "../../core/install-paths.js";
import { logDebug, logError } from "../../core/observability/structured-log.js";

type JsonBody = Record<string, unknown>;

function jsonResponse(body: JsonBody, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(extraHeaders ?? {}) },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

// ── Per-app caches ───────────────────────────────────────────────────────────
//
// The trigger store caches parsed YAML, and the registry caches source
// instances. Both live for the lifetime of the AppContext and are keyed
// by WeakMap so they vacate naturally when the AppContext is disposed.

const storeCache = new WeakMap<AppContext, FileTriggerStore>();
const registryCache = new WeakMap<AppContext, TriggerSourceRegistry>();

function getStore(app: AppContext): FileTriggerStore {
  let store = storeCache.get(app);
  if (!store) {
    store = createFileTriggerStore({
      arkDir: app.config.dirs.ark,
      builtinBaseDir: resolveStoreBaseDir(),
    });
    storeCache.set(app, store);
  }
  return store;
}

function getRegistry(app: AppContext): TriggerSourceRegistry {
  let reg = registryCache.get(app);
  if (!reg) {
    reg = createDefaultRegistry();
    registryCache.set(app, reg);
  }
  return reg;
}

/** Clear the per-app caches -- used by tests and the reload hook. */
export function clearWebhookCaches(app: AppContext): void {
  storeCache.delete(app);
  registryCache.delete(app);
}

// ── Route guard ──────────────────────────────────────────────────────────────

/** Match `/webhooks/:source` or `/api/webhooks/:source`; returns source name or null. */
export function matchWebhookPath(pathname: string): string | null {
  const m = pathname.match(/^\/(?:api\/)?webhooks\/([a-z0-9-]+)\/?$/i);
  return m ? m[1] : null;
}

// ── Main entry point ─────────────────────────────────────────────────────────

export interface WebhookOptions {
  /** Override tenant for the request. Defaults to "default". */
  tenant?: string;
  /** Test-only: supply a pre-built store to skip filesystem scanning. */
  store?: FileTriggerStore;
  /** Test-only: supply a pre-built source registry. */
  registry?: TriggerSourceRegistry;
}

export async function handleWebhookRequest(
  app: AppContext,
  req: Request,
  opts: WebhookOptions = {},
): Promise<Response> {
  const url = new URL(req.url);
  const sourceName = matchWebhookPath(url.pathname);
  if (!sourceName) return jsonResponse({ ok: false, error: "not a webhook path", code: "not_found" }, 404);

  const registry = opts.registry ?? getRegistry(app);
  const source = registry.get(sourceName);
  if (!source) {
    return jsonResponse({ ok: false, error: `unknown source: ${sourceName}`, code: "unknown_source" }, 404);
  }
  // Stub sources are not routable.
  if (source.status === "stub") {
    return jsonResponse({ ok: false, error: `source ${sourceName} is stub-only`, code: "stub_source" }, 404);
  }

  let body: string;
  try {
    body = await req.text();
  } catch (e: any) {
    return jsonResponse({ ok: false, error: `failed to read body: ${e?.message ?? e}`, code: "read_failed" }, 400);
  }

  const tenant = opts.tenant ?? "default";
  const secret = resolveSecret(app.config.dirs.ark, sourceName, tenant);
  if (!secret) {
    return jsonResponse(
      {
        ok: false,
        error: `no signing secret configured for ${sourceName} (tenant=${tenant}). Set ${source.secretEnvVar} or add triggers.${sourceName}.signing_key to ~/.ark/secrets.yaml`,
        code: "missing_secret",
      },
      401,
    );
  }

  const headers = req.headers;
  const verified = await source.verify({ headers, body }, secret);
  if (!verified) {
    return jsonResponse({ ok: false, error: "invalid signature", code: "invalid_signature" }, 401);
  }

  let event: NormalizedEvent;
  try {
    event = await source.normalize({ headers, body });
  } catch (e: any) {
    const code = e instanceof SyntaxError ? "bad_payload" : "normalize_failed";
    const status = e instanceof SyntaxError ? 400 : 500;
    return jsonResponse({ ok: false, error: e?.message ?? String(e), code }, status);
  }

  // Slack URL verification handshake.
  const slackChallenge = extractSlackChallenge(source, event);
  if (slackChallenge) return textResponse(slackChallenge, 200);

  const store = opts.store ?? getStore(app);
  const configs = store.list(tenant);
  const matched = defaultMatcher.match(event, configs);

  if (matched.length === 0) {
    logDebug("triggers", `webhook ${sourceName}/${event.event}: no matching triggers`);
    return jsonResponse({ ok: true, matched: 0, dispatched: [] }, 202);
  }

  // 2xx fast: enqueue dispatch as a microtask so the HTTP response is
  // returned before session-start work runs.
  const dispatcher = new DefaultTriggerDispatcher(app);
  const dispatched: string[] = [];
  for (const cfg of matched) {
    dispatched.push(cfg.name);
    queueMicrotask(() => {
      dispatcher.dispatch({ event, config: cfg }).catch((e: any) => {
        logError("triggers", `dispatch ${cfg.name} failed: ${e?.message ?? e}`);
      });
    });
  }

  return jsonResponse(
    {
      ok: true,
      matched: dispatched.length,
      dispatched,
      event: { source: event.source, event: event.event, ref: event.ref ?? null },
    },
    202,
  );
}

// ── Slack URL verification helper ────────────────────────────────────────────

function extractSlackChallenge(source: TriggerSource, event: NormalizedEvent): string | null {
  if (source.name !== "slack") return null;
  const p = event.payload as { type?: string; challenge?: string } | null;
  if (!p || p.type !== "url_verification") return null;
  if (typeof p.challenge !== "string") return null;
  return p.challenge;
}

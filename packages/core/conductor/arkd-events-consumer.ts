/**
 * Conductor-side reader for arkd's `/events/stream` long-poll. Replaces
 * the SSH `-R 19100:localhost:19100` reverse tunnel that previously
 * carried hook callbacks back to the conductor. The agent's launcher
 * hooks now POST to local arkd's `/hooks/forward`; arkd queues the
 * payloads; this module pulls them as NDJSON and feeds each line into
 * the existing `handleHookStatus` pipeline so nothing downstream
 * changes shape.
 *
 * One reader per remote compute. Started when the compute becomes
 * reachable (right after the forward tunnel is up), stopped when the
 * compute is stopped. The map below is module-scoped because a
 * conductor process owns at most one reader per compute name; the
 * keying matches `app.computes` 1:1.
 *
 * Resilience: the reader auto-reconnects with backoff on any error
 * other than an explicit stop. Failures are logged but never thrown --
 * a flaky network can't kill the conductor.
 */

import type { AppContext } from "../app.js";
import { handleHookStatus } from "./hook-status-handler.js";
import { logDebug, logInfo, logWarn } from "../observability/structured-log.js";

interface ConsumerEntry {
  computeName: string;
  abort: AbortController;
  stopped: boolean;
}

const consumers = new Map<string, ConsumerEntry>();

const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 30_000;

interface NdjsonHookFrame {
  kind: "hook";
  session: string | null;
  query: string;
  body: unknown;
  ts: string;
}

interface NdjsonDroppedFrame {
  kind: "dropped";
  count: number;
  ts: string;
}

type NdjsonFrame = NdjsonHookFrame | NdjsonDroppedFrame;

/**
 * Start the consumer for a compute. Idempotent: a second call for the
 * same compute is a no-op and returns the existing entry's controller.
 *
 * `arkdUrl` is the arkd HTTP base URL (already routed through the
 * forward tunnel, e.g. `http://localhost:59431`). `arkdToken` is the
 * shared bearer; passed straight through.
 */
export function startArkdEventsConsumer(
  app: AppContext,
  computeName: string,
  arkdUrl: string,
  arkdToken: string | null,
): void {
  const existing = consumers.get(computeName);
  if (existing && !existing.stopped) {
    logDebug("conductor", `arkd-events: already running for compute=${computeName}`);
    return;
  }
  const abort = new AbortController();
  const entry: ConsumerEntry = { computeName, abort, stopped: false };
  consumers.set(computeName, entry);
  void runConsumerLoop(app, entry, arkdUrl, arkdToken);
  logInfo("conductor", `arkd-events: consumer started for compute=${computeName} url=${arkdUrl}`);
}

/** Stop a consumer if any. Idempotent. */
export function stopArkdEventsConsumer(computeName: string): void {
  const entry = consumers.get(computeName);
  if (!entry) return;
  entry.stopped = true;
  entry.abort.abort();
  consumers.delete(computeName);
  logInfo("conductor", `arkd-events: consumer stopped for compute=${computeName}`);
}

/** Diagnostic helper: how many consumers are running. */
export function arkdEventsConsumerCount(): number {
  return consumers.size;
}

/**
 * Long-running loop that opens `/events/stream` and stays connected
 * until told to stop. On any error other than a deliberate abort,
 * reconnects with exponential backoff (250ms -> 30s, jitter). Reset
 * to the floor on each successful read.
 */
async function runConsumerLoop(
  app: AppContext,
  entry: ConsumerEntry,
  arkdUrl: string,
  arkdToken: string | null,
): Promise<void> {
  let backoff = RECONNECT_MIN_MS;
  while (!entry.stopped) {
    try {
      await readEventsStreamOnce(app, entry, arkdUrl, arkdToken);
      // Clean stream end (server closed) -- reconnect immediately.
      backoff = RECONNECT_MIN_MS;
    } catch (err: unknown) {
      if (entry.stopped) return;
      const msg = (err as { message?: string })?.message ?? String(err);
      logWarn("conductor", `arkd-events: stream error compute=${entry.computeName}: ${msg}`);
    }
    if (entry.stopped) return;
    const jitter = Math.random() * 0.25 * backoff;
    const delay = Math.min(backoff + jitter, RECONNECT_MAX_MS);
    await sleep(delay, entry.abort.signal);
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  }
}

/** Sleep for `ms` milliseconds, or return early when the signal aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * Open the stream once and pump until end / error / abort. Resets the
 * outer backoff on the FIRST successful chunk so a flaky reconnect
 * loop can't get stuck doubling.
 */
async function readEventsStreamOnce(
  app: AppContext,
  entry: ConsumerEntry,
  arkdUrl: string,
  arkdToken: string | null,
): Promise<void> {
  const url = `${arkdUrl.replace(/\/+$/, "")}/events/stream`;
  const headers: Record<string, string> = {
    // Force a dedicated TCP socket for the long-poll stream so it never
    // enters Bun's keep-alive pool. Without this, every short-lived
    // dispatch fetch (`/exec`, `/file/*`) to the same `localhost:<port>`
    // origin can land on the half-streaming long-poll socket and surface
    // as "The socket connection was closed unexpectedly" mid-clone.
    Connection: "close",
  };
  if (arkdToken) headers.Authorization = `Bearer ${arkdToken}`;

  const resp = await fetch(url, { headers, signal: entry.abort.signal, keepalive: false });
  if (!resp.ok) {
    throw new Error(`arkd /events/stream returned ${resp.status}`);
  }
  if (!resp.body) {
    throw new Error("arkd /events/stream returned no body");
  }
  logInfo("conductor", `arkd-events: stream connected compute=${entry.computeName}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (!entry.stopped) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length > 0) {
        await dispatchFrame(app, line);
      }
      nl = buf.indexOf("\n");
    }
  }
}

/**
 * Parse one NDJSON line and route it to the right downstream handler.
 * Currently only `kind: "hook"` and `kind: "dropped"` are emitted;
 * unknown kinds are logged and ignored so arkd can introduce new
 * frame types without breaking the conductor.
 */
async function dispatchFrame(app: AppContext, line: string): Promise<void> {
  let frame: NdjsonFrame;
  try {
    frame = JSON.parse(line) as NdjsonFrame;
  } catch {
    logWarn("conductor", `arkd-events: malformed JSON line; ignoring`);
    return;
  }
  if (!frame || typeof (frame as { kind?: unknown }).kind !== "string") {
    logWarn("conductor", `arkd-events: untyped frame; ignoring`);
    return;
  }
  if (frame.kind === "dropped") {
    logWarn("conductor", `arkd-events: peer dropped ${frame.count} events`);
    return;
  }
  if (frame.kind === "hook") {
    // Build a synthetic Request that matches the shape `handleHookStatus`
    // expects on the live `/hooks/status` HTTP endpoint, then dispatch.
    // The handler reads:
    //   - URL search params (we re-attach the original query string)
    //   - req.json() for the payload (we serialise the parsed body back)
    //   - tenant from `appForRequest(app, req)` -- single-tenant default
    //     mode resolves to the localAdminContext, which is what the old
    //     `-R` path also used for hook callbacks.
    const url = new URL(`http://internal/hooks/status${frame.query ? "?" + frame.query : ""}`);
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(frame.body),
    });
    try {
      const resp = await handleHookStatus(app, req, url);
      if (!resp.ok) {
        logDebug("conductor", `arkd-events: hook handler returned ${resp.status} for session=${frame.session}`);
      }
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      logWarn("conductor", `arkd-events: hook dispatch threw: ${msg}`);
    }
    return;
  }
  logDebug("conductor", `arkd-events: unhandled frame kind=${(frame as { kind: string }).kind}`);
}

/** Test helper: drop all consumers without going through the network. */
export function _resetArkdEventsConsumers(): void {
  for (const entry of consumers.values()) {
    entry.stopped = true;
    entry.abort.abort();
  }
  consumers.clear();
}

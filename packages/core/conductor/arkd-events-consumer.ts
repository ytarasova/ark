/**
 * Conductor-side reader for arkd's generic `hooks` channel
 * (`/channel/hooks/subscribe`). Replaces the SSH `-R 19100:localhost:19100`
 * reverse tunnel that previously carried hook callbacks back to the
 * conductor. The agent's launcher hooks publish on the local arkd's `hooks`
 * channel; arkd buffers envelopes; this module subscribes as NDJSON and
 * dispatches each envelope into the existing handler pipelines so nothing
 * downstream changes shape.
 *
 * Channel reports + agent-to-agent relays travel the same channel. Pre-SSM
 * arkd would POST these directly to `${conductor}/api/channel/<sid>` and
 * `${conductor}/api/relay`, which only worked because the SSH `-R` tunnel
 * mapped the compute's `localhost:19100` back to the dev-box conductor.
 * Under pure SSM there is no reverse path, so arkd publishes those payloads
 * as `channel-report` / `channel-relay` envelopes on the same `hooks`
 * channel and we drain them here, dispatching through `handleReport` and
 * the channel-relay path respectively. See `arkd/routes/channel.ts` for
 * publishers and `arkd/routes/channels.ts` for the generic pub/sub.
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

import type { Session } from "../../types/index.js";
import type { AppContext } from "../app.js";
import { handleHookStatus } from "./hook-status-handler.js";
import { handleReport } from "./report-pipeline.js";
import type { OutboundMessage } from "./channel-types.js";
import { deliverToChannel } from "./deliver-to-channel.js";
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

interface NdjsonChannelReportFrame {
  kind: "channel-report";
  session: string;
  tenantId: string | null;
  body: unknown;
  ts: string;
}

interface NdjsonChannelRelayFrame {
  kind: "channel-relay";
  tenantId: string | null;
  body: unknown;
  ts: string;
}

type NdjsonFrame = NdjsonHookFrame | NdjsonChannelReportFrame | NdjsonChannelRelayFrame;

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
 * Long-running loop that opens `/channel/hooks/subscribe` and stays
 * connected until told to stop. On any error other than a deliberate
 * abort, reconnects with exponential backoff (250ms -> 30s, jitter).
 * Reset to the floor on each successful read.
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
      await readHooksChannelOnce(app, entry, arkdUrl, arkdToken);
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
 * Open the channel subscribe stream once and pump until end / error /
 * abort.
 */
async function readHooksChannelOnce(
  app: AppContext,
  entry: ConsumerEntry,
  arkdUrl: string,
  arkdToken: string | null,
): Promise<void> {
  const url = `${arkdUrl.replace(/\/+$/, "")}/channel/hooks/subscribe`;
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
    throw new Error(`arkd /channel/hooks/subscribe returned ${resp.status}`);
  }
  if (!resp.body) {
    throw new Error("arkd /channel/hooks/subscribe returned no body");
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
 * Tenant-scope an AppContext by id, mirroring what `appForRequest` does
 * for the live HTTP path. `null` / empty strings fall through to the
 * unscoped app (the local-mode default), which matches the pre-fix
 * behaviour when the agent didn't send `X-Ark-Tenant-Id`.
 */
function scopeApp(app: AppContext, tenantId: string | null): AppContext {
  if (!tenantId) return app;
  try {
    return app.forTenant(tenantId);
  } catch {
    return app;
  }
}

/**
 * Parse one NDJSON line and route it to the right downstream handler.
 * Currently `hook`, `channel-report`, and `channel-relay` are emitted;
 * unknown kinds are logged and ignored so arkd / publishers can introduce
 * new envelope types without breaking the conductor.
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
  if (frame.kind === "channel-report") {
    // Mirror the legacy `/api/channel/:sessionId` HTTP route on conductor.ts:
    // resolve the tenant-scoped app, then run `handleReport`. Tenant scoping
    // is critical -- without it a hosted-mode conductor would write the
    // session update against the wrong tenant's repo and the UI would never
    // see the completion.
    const scoped = scopeApp(app, frame.tenantId);
    const report = frame.body as OutboundMessage;
    try {
      await handleReport(scoped, frame.session, report);
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      logWarn("conductor", `arkd-events: channel-report dispatch threw for session=${frame.session}: ${msg}`);
    }
    return;
  }
  if (frame.kind === "channel-relay") {
    // Mirror the legacy `/api/relay` HTTP route. The relay payload looks up
    // the target session, computes the channel port, and pushes a `steer`
    // payload via `deliverToChannel` (which already prefers arkd over direct
    // HTTP and re-scopes by the target session's own tenant).
    const scoped = scopeApp(app, frame.tenantId);
    const relay = frame.body as { from: string; target: string; message: string };
    if (!relay || typeof relay.target !== "string") {
      logWarn("conductor", `arkd-events: channel-relay missing target; ignoring`);
      return;
    }
    try {
      const targetSession = await scoped.sessions.get(relay.target);
      if (targetSession) {
        const channelPort = scoped.sessions.channelPort(relay.target);
        const payload = {
          type: "steer",
          message: relay.message,
          from: relay.from,
          sessionId: relay.target,
        };
        await deliverToChannel(scoped, targetSession as Session, channelPort, payload);
      }
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? String(err);
      logWarn("conductor", `arkd-events: channel-relay dispatch threw target=${relay.target}: ${msg}`);
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

/**
 * ConductorClient -- persistent ArkClient WebSocket connection from arkd to
 * the conductor.
 *
 * Replaces the fire-and-forget `fetch()` calls that used to POST to the REST
 * endpoints on the conductor (pre-merge). The conductor now accepts these
 * same operations as typed JSON-RPC 2.0 methods over a persistent WebSocket.
 *
 * Connection model:
 *   - ONE ArkClient per arkd instance, dialed at construction time.
 *   - The underlying transport reconnects with exponential backoff
 *     (built into `createWebSocketTransport` in packages/protocol/transport.ts).
 *   - On every successful reconnection the client re-issues worker/register
 *     automatically so the conductor registry stays consistent.
 *   - All public methods are fire-and-forget: they catch errors and log to
 *     stderr rather than propagating, matching the existing behaviour of the
 *     old fetch() calls.
 *
 * URL normalisation:
 *   Accepts `ws://`, `wss://`, `http://`, or `https://`. HTTP schemes are
 *   translated to WS so callers that still pass legacy `http://localhost:19100`
 *   strings continue to work.
 */

import { ArkClient } from "../../protocol/client.js";
import { createWebSocketTransport } from "../../protocol/transport.js";
import type { WorkerRegisterParams } from "../../protocol/rpc-schemas.js";

export interface ConductorClientHandle {
  /** Immediately fire a worker/heartbeat RPC. Used by the heartbeat timer. */
  heartbeat(): void;
  /** Fire a worker/deregister RPC and then close the WS. Best-effort. */
  deregister(): Promise<void>;
}

/** Translate http(s):// to ws(s):// and append /ws path for the JSON-RPC WS endpoint. */
function toWsUrl(url: string): string {
  return (
    url
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://")
      .replace(/\/$/, "") + "/ws"
  );
}

/**
 * Dial a persistent ArkClient WebSocket to the conductor and register the
 * worker. Returns a handle with `heartbeat()` and `deregister()` methods.
 */
export async function createConductorClient(
  conductorUrl: string,
  registerParams: WorkerRegisterParams,
  token?: string | null,
): Promise<ConductorClientHandle> {
  const wsUrl = toWsUrl(conductorUrl);

  // `client` is assigned after `await ready` below. The onStatus callback
  // fires on the same microtask tick as `ready` resolving, so we must guard
  // the re-register call with a null check and schedule it with a microtask
  // delay to ensure `client` is set before the call executes.
  let client: ArkClient | null = null;

  const { transport, ready } = createWebSocketTransport(wsUrl, {
    token: token ?? undefined,
    reconnect: true,
    maxReconnectDelay: 30_000,
    onStatus: (status) => {
      if (status === "connected") {
        // Re-register on every reconnect so the conductor registry does not
        // hold a stale entry pointing at a newly restarted arkd instance.
        // Use queueMicrotask so that `client` is guaranteed to be assigned
        // (the initial `ready` resolution and this callback fire in the same
        // microtask checkpoint -- we need one more turn of the event loop).
        queueMicrotask(() => {
          client
            ?.workerRegister(registerParams)
            .catch((err: unknown) =>
              process.stderr.write(`[arkd] worker/register on reconnect failed: ${(err as Error)?.message ?? err}\n`),
            );
        });
      }
    },
  });

  // Wait for the initial connection before creating the ArkClient and issuing
  // the first register. If the conductor is not yet up, the transport will
  // retry; we propagate the error to the caller who logs it and retries via
  // the reconnect loop.
  try {
    await ready;
  } catch (err: unknown) {
    // Conductor not reachable -- create the client anyway so the handle is
    // valid; the transport's reconnect loop will fire register via onStatus
    // once the connection succeeds.
    process.stderr.write(`[arkd] initial conductor connect failed (will retry): ${(err as Error)?.message ?? err}\n`);
  }

  client = new ArkClient(transport);

  // Initial registration -- must land before the first heartbeat tick.
  // Fire-and-forget; if this fails the heartbeat will re-register.
  client
    .workerRegister(registerParams)
    .catch((err: unknown) =>
      process.stderr.write(`[arkd] initial worker/register failed: ${(err as Error)?.message ?? err}\n`),
    );

  return {
    heartbeat() {
      client
        ?.workerHeartbeat({ id: registerParams.id })
        .catch((err: unknown) =>
          process.stderr.write(`[arkd] worker/heartbeat failed: ${(err as Error)?.message ?? err}\n`),
        );
    },

    async deregister(): Promise<void> {
      try {
        await client?.workerDeregister({ id: registerParams.id });
      } catch {
        // best effort
      } finally {
        client?.close();
      }
    },
  };
}

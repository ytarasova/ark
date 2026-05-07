/**
 * Control plane registration and heartbeat for arkd workers.
 *
 * When ARK_CONTROL_PLANE_URL (or ARK_CONDUCTOR_URL) is set, arkd registers
 * itself with the conductor over a persistent ArkClient WebSocket on startup,
 * sends a heartbeat every 30s, and deregisters on shutdown.
 *
 * The underlying transport (createWebSocketTransport) handles reconnection
 * with exponential backoff. On every reconnect the client automatically
 * re-issues worker/register so the conductor registry stays consistent.
 *
 * Extracted from server.ts to keep server.ts focused on Bun.serve wiring.
 */

import { hostname, platform } from "os";
import { createConductorClient, type ConductorClientHandle } from "./conductor-client.js";

export interface ControlPlaneHandle {
  /** Stop the heartbeat and send a worker/deregister to the conductor. */
  stop(): void;
}

/**
 * Register this arkd worker with the conductor and start the 30s heartbeat.
 * Returns null when neither ARK_CONTROL_PLANE_URL nor ARK_CONDUCTOR_URL is
 * set (local mode).
 *
 * The `token` parameter is the bearer token the conductor requires for
 * worker-role JSON-RPC calls (ARK_ARKD_TOKEN / opts.token in server.ts).
 *
 * The conductor URL may be an http://, https://, ws://, or wss:// URL.
 * HTTP schemes are translated to WS internally.
 */
export async function startControlPlane(port: number, token?: string | null): Promise<ControlPlaneHandle | null> {
  // Prefer the dedicated control-plane URL; fall back to the general
  // conductor URL. Neither set means local mode -- no control plane.
  const controlPlaneUrl = process.env.ARK_CONTROL_PLANE_URL ?? process.env.ARK_CONDUCTOR_URL;
  if (!controlPlaneUrl) return null;

  const workerId = process.env.ARK_WORKER_ID || `worker-${hostname()}-${port}`;
  const workerCapacity = parseInt(process.env.ARK_WORKER_CAPACITY ?? "5", 10);
  const workerUrl = `http://${hostname()}:${port}`;

  const registerParams = {
    id: workerId,
    url: workerUrl,
    capacity: workerCapacity,
    compute_name: process.env.ARK_COMPUTE_NAME || undefined,
    tenant_id: process.env.ARK_TENANT_ID || undefined,
    metadata: { hostname: hostname(), platform: platform(), port },
  };

  let conductorHandle: ConductorClientHandle | null = null;

  // Dial the conductor asynchronously -- we do not block the Bun.serve
  // startup on this. If the conductor is not yet up the transport will
  // retry and re-register once it connects.
  createConductorClient(controlPlaneUrl, registerParams, token)
    .then((h) => {
      conductorHandle = h;
    })
    .catch((err: unknown) => {
      process.stderr.write(`[arkd] control-plane connect failed: ${(err as Error)?.message ?? err}\n`);
    });

  // Heartbeat every 30s
  const heartbeatTimer = setInterval(() => {
    conductorHandle?.heartbeat();
  }, 30_000);

  return {
    stop() {
      clearInterval(heartbeatTimer);
      // Fire-and-forget deregister + WS close on shutdown.
      conductorHandle?.deregister().catch(() => {
        /* best effort */
      });
    },
  };
}

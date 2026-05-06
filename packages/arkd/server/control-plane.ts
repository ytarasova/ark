/**
 * Control plane registration and heartbeat for arkd workers.
 *
 * When ARK_CONTROL_PLANE_URL is set, arkd registers itself with the control
 * plane on startup, sends a heartbeat every 30s, and deregisters on shutdown.
 * Extracted from server.ts to keep server.ts focused on Bun.serve wiring.
 */

import { hostname, platform } from "os";

export interface ControlPlaneHandle {
  /** Stop the heartbeat and POST a deregister to the control plane. */
  stop(): void;
}

/**
 * Register this arkd worker with the control plane and start the 30s
 * heartbeat. Returns null when ARK_CONTROL_PLANE_URL is unset (local mode).
 *
 * The initial registration is fire-and-forget; if the control plane is not
 * yet ready the heartbeat will retry naturally on the next tick.
 */
export function startControlPlane(port: number): ControlPlaneHandle | null {
  const controlPlaneUrl = process.env.ARK_CONTROL_PLANE_URL;
  if (!controlPlaneUrl) return null;

  const workerId = process.env.ARK_WORKER_ID || `worker-${hostname()}-${port}`;
  const workerCapacity = parseInt(process.env.ARK_WORKER_CAPACITY ?? "5", 10);

  // Register with control plane
  const workerUrl = `http://${hostname()}:${port}`;
  const registerPayload = {
    id: workerId,
    url: workerUrl,
    capacity: workerCapacity,
    compute_name: process.env.ARK_COMPUTE_NAME || null,
    tenant_id: process.env.ARK_TENANT_ID || null,
    metadata: { hostname: hostname(), platform: platform(), port },
  };

  // Initial registration (fire and forget)
  fetch(`${controlPlaneUrl}/api/workers/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(registerPayload),
  }).catch(() => {
    /* control plane not ready yet -- heartbeat will retry */
  });

  // Heartbeat every 30s
  const heartbeatTimer = setInterval(() => {
    fetch(`${controlPlaneUrl}/api/workers/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: workerId }),
    }).catch(() => {
      /* control plane unreachable */
    });
  }, 30_000);

  return {
    stop() {
      clearInterval(heartbeatTimer);
      // Deregister from control plane on shutdown
      fetch(`${controlPlaneUrl}/api/workers/deregister`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: workerId }),
      }).catch(() => {
        /* best effort */
      });
    },
  };
}

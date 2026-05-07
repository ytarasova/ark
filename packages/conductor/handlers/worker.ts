/**
 * Worker-registry JSON-RPC handlers (hosted control plane only).
 *
 * These handlers replace the equivalent REST endpoints in
 * `packages/core/conductor/server/worker-handlers.ts`. The REST endpoints
 * continue to serve in parallel until Phase E removes them.
 *
 * The worker registry is only available in hosted mode. Calls against a
 * local-mode `app` throw "hosted mode only" from the registry accessor; we
 * translate that single error to an INTERNAL_ERROR RpcError with a clear
 * message rather than propagating the raw stack.
 */

import { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { RpcError, ErrorCodes } from "../../protocol/types.js";

/** Translate the hosted-mode guard into a clean RpcError. */
function translateHostedModeError(e: any): never {
  if (e?.message?.includes("hosted mode only")) {
    throw new RpcError("Worker registry not available (not running in hosted mode)", ErrorCodes.INTERNAL_ERROR);
  }
  throw e;
}

export function registerWorkerHandlers(router: Router, app: AppContext): void {
  // ── worker/register ────────────────────────────────────────────────────────
  //
  // Registers an arkd worker with the hosted control-plane registry.
  // Mirrors POST /api/workers/register from the legacy REST surface.

  router.handle("worker/register", async (params, _notify, _ctx) => {
    const opts = extract<{
      id: string;
      url: string;
      capacity?: number;
      compute_name?: string;
      tenant_id?: string;
      metadata?: Record<string, unknown>;
    }>(params, ["id", "url"]);
    try {
      await app.workerRegistry.register({
        id: opts.id,
        url: opts.url,
        capacity: opts.capacity ?? 5,
        compute_name: opts.compute_name ?? null,
        tenant_id: opts.tenant_id ?? null,
        metadata: opts.metadata ?? {},
      });
      return { status: "registered", id: opts.id };
    } catch (e: any) {
      translateHostedModeError(e);
    }
  });

  // ── worker/heartbeat ───────────────────────────────────────────────────────

  router.handle("worker/heartbeat", async (params, _notify, _ctx) => {
    const { id } = extract<{ id: string }>(params, ["id"]);
    try {
      await app.workerRegistry.heartbeat(id);
      return { status: "ok" };
    } catch (e: any) {
      translateHostedModeError(e);
    }
  });

  // ── worker/deregister ──────────────────────────────────────────────────────

  router.handle("worker/deregister", async (params, _notify, _ctx) => {
    const { id } = extract<{ id: string }>(params, ["id"]);
    try {
      await app.workerRegistry.deregister(id);
      return { status: "deregistered", id };
    } catch (e: any) {
      translateHostedModeError(e);
    }
  });

  // ── worker/list ────────────────────────────────────────────────────────────

  router.handle("worker/list", async (_params, _notify, _ctx) => {
    try {
      const workers = await app.workerRegistry.list();
      return { workers };
    } catch (e: any) {
      translateHostedModeError(e);
    }
  });
}

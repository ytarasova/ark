/**
 * Worker-registry HTTP handlers (hosted control plane only).
 *
 * The worker registry is populated in hosted mode; calls against a local-mode
 * `app` surface as 503s via the "hosted mode only" guard thrown by the registry
 * accessor. We intentionally swallow and translate that single error to a
 * clean 503 rather than propagate the raw stack.
 */

import type { AppContext } from "../../app.js";
import { logInfo } from "../../observability/structured-log.js";

export async function handleWorkerRegister(app: AppContext, req: Request): Promise<Response> {
  try {
    const registry = app.workerRegistry;
    const body = (await req.json()) as {
      id: string;
      url: string;
      capacity?: number;
      compute_name?: string;
      tenant_id?: string;
      metadata?: Record<string, unknown>;
    };
    if (!body.id || !body.url) {
      return Response.json({ error: "id and url are required" }, { status: 400 });
    }
    registry.register({
      id: body.id,
      url: body.url,
      capacity: body.capacity ?? 5,
      compute_name: body.compute_name ?? null,
      tenant_id: body.tenant_id ?? null,
      metadata: body.metadata ?? {},
    });
    logInfo("conductor", `Worker registered: ${body.id} (${body.url})`);
    return Response.json({ status: "registered", id: body.id });
  } catch (e: any) {
    if (e.message?.includes("hosted mode only")) {
      return Response.json({ error: "Worker registry not available (not running in hosted mode)" }, { status: 503 });
    }
    throw e;
  }
}

export async function handleWorkerHeartbeat(app: AppContext, req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { id: string };
    if (!body.id) {
      return Response.json({ error: "id is required" }, { status: 400 });
    }
    app.workerRegistry.heartbeat(body.id);
    return Response.json({ status: "ok" });
  } catch (e: any) {
    if (e.message?.includes("hosted mode only")) {
      return Response.json({ error: "Worker registry not available" }, { status: 503 });
    }
    throw e;
  }
}

export async function handleWorkerDeregister(app: AppContext, req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { id: string };
    if (!body.id) {
      return Response.json({ error: "id is required" }, { status: 400 });
    }
    app.workerRegistry.deregister(body.id);
    logInfo("conductor", `Worker deregistered: ${body.id}`);
    return Response.json({ status: "deregistered" });
  } catch (e: any) {
    if (e.message?.includes("hosted mode only")) {
      return Response.json({ error: "Worker registry not available" }, { status: 503 });
    }
    throw e;
  }
}

export function handleWorkerList(app: AppContext): Response {
  try {
    const workers = app.workerRegistry.list();
    return Response.json(workers);
  } catch (e: any) {
    if (e.message?.includes("hosted mode only")) {
      return Response.json({ error: "Worker registry not available" }, { status: 503 });
    }
    throw e;
  }
}

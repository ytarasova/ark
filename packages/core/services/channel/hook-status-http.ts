/**
 * HTTP wrapper for the hook-status processor.
 *
 * This thin adapter reads the session param from the URL search params and
 * the payload from the request body, then delegates to `processHookPayload`.
 * Used by both the merged server port (via `packages/conductor/mounts/hooks.ts`)
 * and test helpers that start a minimal HTTP server.
 */

import type { AppContext } from "../../app.js";
import { appForRequest } from "./tenant.js";
import { processHookPayload } from "./hook-status.js";

export async function handleHookStatusHttp(app: AppContext, req: Request, url: URL): Promise<Response> {
  const sessionId = url.searchParams.get("session");
  if (!sessionId) return Response.json({ error: "missing session param" }, { status: 400 });

  const resolved = await appForRequest(app, req);
  if (resolved.ok === false) return resolved.response;
  const scoped = resolved.app;
  const s = await scoped.sessions.get(sessionId);
  if (!s) return Response.json({ error: "session not found" }, { status: 404 });

  const payload = (await req.json()) as Record<string, unknown>;
  const hookResult = await processHookPayload(scoped, sessionId, s, payload);

  if (hookResult.guardrail !== undefined) {
    return Response.json({ status: "ok", guardrail: hookResult.guardrail });
  }
  return Response.json({ status: "ok", mapped: hookResult.mapped });
}

/**
 * `/hooks/status` HTTP handler.
 *
 * Accepts two classes of payloads on the same endpoint:
 *   1. Classic hook events from the claude runtime (`hook_event_name` set).
 *   2. Channel-report passthrough from agent-sdk MCP `ask_user` and other
 *      non-hook emitters (`type: "question"|"progress"|"error"`) -- these
 *      are normalised into `OutboundMessage` and routed through the shared
 *      report pipeline so the UI sees one event shape regardless of source.
 *
 * The handler also evaluates guardrails on `PreToolUse` events and runs
 * the on-failure retry + terminal-cleanup side-effects for hook-driven
 * status transitions.
 */

import type { AppContext } from "../../app.js";
import { appForRequest } from "./tenant.js";
import { handleHookStatus as handleHookStatusSignal } from "../../services/session-signals.js";

export async function handleHookStatus(app: AppContext, req: Request, url: URL): Promise<Response> {
  const sessionId = url.searchParams.get("session");
  if (!sessionId) return Response.json({ error: "missing session param" }, { status: 400 });

  const resolved = await appForRequest(app, req);
  if (resolved.ok === false) return resolved.response;
  const scoped = resolved.app;
  const s = await scoped.sessions.get(sessionId);
  if (!s) return Response.json({ error: "session not found" }, { status: 404 });

  const payload = (await req.json()) as Record<string, unknown>;
  const event = String(payload.hook_event_name ?? "");

  const mapped = await handleHookStatusSignal(scoped, sessionId, event, payload);

  // Map the internal return strings back to HTTP response shapes that
  // preserve the original response body contract.
  if (mapped === "session_not_found") {
    return Response.json({ error: "session not found" }, { status: 404 });
  }
  if (mapped.startsWith("mapped:")) {
    return Response.json({ status: "ok", mapped: mapped.slice("mapped:".length) });
  }
  if (mapped === "ignored_stale") {
    return Response.json({ status: "ok", mapped: "ignored_stale" });
  }
  if (mapped === "agent_message") {
    return Response.json({ status: "ok", mapped: "agent_message" });
  }
  if (mapped.startsWith("guardrail:")) {
    return Response.json({ status: "ok", guardrail: mapped.slice("guardrail:".length) });
  }
  if (mapped === "retry") {
    return Response.json({ status: "ok", mapped: "retry" });
  }
  return Response.json({ status: "ok", mapped });
}

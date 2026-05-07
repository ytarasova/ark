/**
 * Hook JSON-RPC handler.
 *
 * This handler replaces the equivalent REST endpoint in the legacy conductor:
 *   POST /hooks/status  ->  hook/forward
 *
 * The REST endpoint continues to serve in parallel until Phase E removes it.
 *
 * Business logic lives in `processHookPayload` (extracted from
 * `hook-status-handler.ts`) so both transports share one implementation.
 */

import { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { processHookPayload } from "../../core/conductor/server/hook-status-handler.js";
import { resolveTenantApp } from "./scope-helpers.js";

export function registerHookHandlers(router: Router, app: AppContext): void {
  // ── hook/forward ────────────────────────────────────────────────────────────
  //
  // Forwards a hook event or channel-report passthrough for a session through
  // the shared `processHookPayload` pipeline. Mirrors POST /hooks/status from
  // the legacy REST surface.
  //
  // Accepts two payload classes (same as the REST endpoint):
  //   1. Classic hook events (`hook_event_name` set) -- PreToolUse, PostToolUse,
  //      SessionEnd, AgentMessage, etc.
  //   2. Channel-report passthrough (`type: "question"|"progress"|"error"`)
  //      from agent-sdk MCP emitters that don't set `hook_event_name`.

  router.handle("hook/forward", async (params, _notify, ctx) => {
    const opts = extract<{ sessionId: string; payload: Record<string, unknown> }>(params, ["sessionId", "payload"]);
    const scoped = resolveTenantApp(app, ctx);
    const session = await scoped.sessions.get(opts.sessionId);
    if (!session) throw new RpcError("unknown session", ErrorCodes.SESSION_NOT_FOUND);
    const result = await processHookPayload(scoped, opts.sessionId, session, opts.payload);
    if (result.guardrail !== undefined) {
      return { ok: true, guardrail: result.guardrail, mapped: result.mapped };
    }
    return { ok: true, mapped: result.mapped };
  });
}

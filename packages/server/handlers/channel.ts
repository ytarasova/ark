/**
 * Channel JSON-RPC handlers.
 *
 * These handlers replace the equivalent REST endpoints in the legacy conductor:
 *   POST /api/channel/:sessionId  ->  channel/deliver
 *   POST /api/relay               ->  channel/relay
 *
 * The REST channel endpoints (/api/channel, /api/relay) have been removed.
 */

import { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { handleReport } from "../../core/services/channel/report-pipeline.js";
import { deliverToChannel } from "../../core/services/channel/deliver.js";
import type { OutboundMessage } from "../../core/services/channel/channel-types.js";
import { resolveTenantApp } from "./scope-helpers.js";

export function registerChannelHandlers(router: Router, app: AppContext): void {
  // ── channel/deliver ─────────────────────────────────────────────────────────
  //
  // Receives an agent report for a session and routes it through the shared
  // report pipeline. Mirrors POST /api/channel/:sessionId from the legacy
  // REST surface.

  router.handle("channel/deliver", async (params, _notify, ctx) => {
    const opts = extract<{ sessionId: string; report: OutboundMessage }>(params, ["sessionId", "report"]);
    const scoped = resolveTenantApp(app, ctx);
    const session = await scoped.sessions.get(opts.sessionId);
    if (!session) throw new RpcError("unknown session", ErrorCodes.SESSION_NOT_FOUND);
    await handleReport(scoped, opts.sessionId, opts.report);
    return { ok: true };
  });

  // ── channel/relay ───────────────────────────────────────────────────────────
  //
  // Relays a message from one agent session to another via the target session's
  // channel port. Mirrors POST /api/relay from the legacy REST surface.
  //
  // The legacy relay wraps the payload as `{ type: "steer", message, from,
  // sessionId }`. This handler accepts a pre-built payload so callers can send
  // any channel message type, matching what the REST surface did after parsing
  // the body (see handleAgentRelay in conductor.ts which constructs the steer
  // shape before calling deliverToChannel).

  router.handle("channel/relay", async (params, _notify, ctx) => {
    const opts = extract<{ toSession: string; payload: Record<string, unknown>; fromSession?: string }>(params, [
      "toSession",
      "payload",
    ]);
    const scoped = resolveTenantApp(app, ctx);
    const target = await scoped.sessions.get(opts.toSession);
    if (!target) throw new RpcError("unknown target session", ErrorCodes.SESSION_NOT_FOUND);
    const channelPort = scoped.sessions.channelPort(opts.toSession);
    await deliverToChannel(scoped, target, channelPort, opts.payload);
    return { ok: true };
  });
}

/**
 * /channel/* routes: report, relay, deliver.
 *
 * Direction summary:
 *   - `/channel/<sid>`  agent -> conductor (report)        : enqueue + stream
 *   - `/channel/relay`  agent -> conductor (a2a relay)     : enqueue + stream
 *   - `/channel/deliver` conductor -> agent (local socket) : direct HTTP, unchanged
 *
 * Pre-SSM (SSH `-R 19100:localhost:19100` reverse tunnel) the agent->conductor
 * legs were able to call `${conductorUrl}/api/...` directly because the tunnel
 * mapped the EC2 instance's loopback to the dev box's conductor. With pure
 * SSM there is NO reverse path -- `localhost:19100` on EC2 is the EC2 instance
 * itself, where no conductor runs, so the POST silently fails and the report
 * is lost (sessions stuck at "running" forever).
 *
 * Fix: instead of POSTing out to the conductor, enqueue the payload onto the
 * arkd events ring. The conductor's `arkd-events-consumer` long-poll on
 * `/events/stream` is the only conductor-reachable path post-SSH-removal, and
 * it now drains `channel-report` / `channel-relay` frames alongside the
 * existing hook frames. See `routes/events.ts` for the queue and
 * `core/conductor/arkd-events-consumer.ts` for the consumer dispatch.
 *
 * `/channel/deliver` is in the OPPOSITE direction (the conductor is calling
 * arkd over the forward `-L` tunnel to push a payload to a session's local
 * channel port). The forward path always works under SSM, so deliver does
 * not need the queue treatment.
 */

import { DEFAULT_CHANNEL_BASE_URL } from "../../core/constants.js";
import type {
  ChannelReportRes,
  ChannelRelayReq,
  ChannelRelayRes,
  ChannelDeliverReq,
  ChannelDeliverRes,
} from "../types.js";
import { json, type RouteCtx } from "../internal.js";
import { enqueueChannelReport, enqueueChannelRelay } from "./events.js";

function channelReport(sessionId: string, report: Record<string, unknown>, tenantId: string | null): ChannelReportRes {
  // Hand off to the events ring; the conductor's `/events/stream`
  // consumer pulls frames over the forward tunnel and dispatches them
  // through the same `handleReport` pipeline the legacy direct POST
  // used. Best-effort delivery -- if the conductor is disconnected the
  // frame waits in the ring (bounded; oldest-drop on overflow).
  enqueueChannelReport(sessionId, report, tenantId);
  return { ok: true, forwarded: true };
}

function channelRelay(req: ChannelRelayReq, tenantId: string | null): ChannelRelayRes {
  enqueueChannelRelay(req, tenantId);
  return { ok: true, forwarded: true };
}

async function channelDeliver(req: ChannelDeliverReq): Promise<ChannelDeliverRes> {
  try {
    const resp = await fetch(`${DEFAULT_CHANNEL_BASE_URL}:${req.channelPort}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.payload),
    });
    return { ok: true, delivered: resp.ok };
  } catch {
    return { ok: true, delivered: false };
  }
}

export async function handleChannelRoutes(req: Request, path: string, _ctx: RouteCtx): Promise<Response | null> {
  // ── Channel: report (agent → conductor via arkd events ring) ─────────
  if (req.method === "POST" && path.startsWith("/channel/") && !path.endsWith("/relay") && !path.endsWith("/deliver")) {
    const sessionId = path.split("/")[2]!;
    const report = (await req.json()) as Record<string, unknown>;
    const tenantId = req.headers.get("x-ark-tenant-id") ?? req.headers.get("X-Ark-Tenant-Id");
    return json(channelReport(sessionId, report, tenantId));
  }

  // ── Channel: relay (agent → agent via conductor) ─────────────────────
  if (req.method === "POST" && path === "/channel/relay") {
    const body = (await req.json()) as ChannelRelayReq;
    const tenantId = req.headers.get("x-ark-tenant-id") ?? req.headers.get("X-Ark-Tenant-Id");
    return json(channelRelay(body, tenantId));
  }

  // ── Channel: deliver (conductor → agent on this compute) ─────────────
  if (req.method === "POST" && path === "/channel/deliver") {
    const body = (await req.json()) as ChannelDeliverReq;
    return json(await channelDeliver(body));
  }

  return null;
}

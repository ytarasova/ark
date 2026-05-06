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
 * Fix: instead of POSTing out to the conductor, publish the payload onto
 * the generic `hooks` channel. The conductor's `arkd-events-consumer`
 * subscribes via `/channel/hooks/subscribe` -- the only conductor-reachable
 * path post-SSH-removal -- and drains `channel-report` / `channel-relay`
 * envelopes alongside the existing hook envelopes. See `routes/channels.ts`
 * for the channel primitive and `core/conductor/arkd-events-consumer.ts`
 * for the consumer dispatch.
 *
 * `/channel/deliver` is in the OPPOSITE direction (the conductor is calling
 * arkd over the forward `-L` tunnel to push a payload to a session's local
 * channel port). The forward path always works under SSM, so deliver does
 * not need the queue treatment.
 */

import { DEFAULT_CHANNEL_BASE_URL } from "../../../core/constants.js";
import type {
  ChannelReportRes,
  ChannelRelayReq,
  ChannelRelayRes,
  ChannelDeliverReq,
  ChannelDeliverRes,
} from "../../common/types.js";
import { json } from "../helpers.js";
import { type RouteCtx } from "../route-ctx.js";
import { publishOnChannel } from "../channel-bus.js";

/**
 * Channel name on which agent->conductor frames (hook events, channel
 * reports, channel relays) are multiplexed. The conductor's
 * `arkd-events-consumer` subscribes here and dispatches by `kind`.
 */
const HOOKS_CHANNEL = "hooks";

function channelReport(sessionId: string, report: Record<string, unknown>, tenantId: string | null): ChannelReportRes {
  // Hand off to the generic `hooks` channel; the conductor subscribes via
  // /channel/hooks/subscribe over the forward tunnel and dispatches each
  // envelope by `kind`. Best-effort delivery -- if the conductor is
  // disconnected the envelope waits buffered until the next subscribe.
  publishOnChannel(HOOKS_CHANNEL, {
    kind: "channel-report",
    session: sessionId,
    tenantId,
    body: report,
    ts: new Date().toISOString(),
  });
  return { ok: true, forwarded: true };
}

function channelRelay(req: ChannelRelayReq, tenantId: string | null): ChannelRelayRes {
  publishOnChannel(HOOKS_CHANNEL, {
    kind: "channel-relay",
    tenantId,
    body: req,
    ts: new Date().toISOString(),
  });
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
  // ── Channel: report (agent → conductor via arkd hooks channel) ───────
  // Pattern: POST /channel/<sessionId>  (no trailing verb)
  // Excludes:
  //   /channel/relay, /channel/deliver -- legacy sibling routes below
  //   /channel/<name>/publish, /channel/<name>/subscribe -- generic
  //     pub/sub routes handled by routes/channels.ts (mounted ahead).
  if (
    req.method === "POST" &&
    path.startsWith("/channel/") &&
    !path.endsWith("/relay") &&
    !path.endsWith("/deliver") &&
    !path.endsWith("/publish") &&
    !path.endsWith("/subscribe")
  ) {
    const segments = path.split("/").filter(Boolean);
    // Reject nested paths so the legacy report route can never collide with
    // a future /channel/<name>/<verb> shape that hasn't been added yet.
    if (segments.length !== 2) return null;
    const sessionId = segments[1]!;
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

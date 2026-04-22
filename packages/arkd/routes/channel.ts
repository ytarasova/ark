/**
 * /channel/* routes: report, relay, deliver.
 *
 * Extracted from server.ts. `report` and `relay` forward to the conductor
 * using `ctx.getConductorUrl()`; `deliver` hits a local channel port.
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

async function channelReport(
  sessionId: string,
  report: Record<string, unknown>,
  conductorUrl: string | null,
  tenantId?: string | null,
): Promise<ChannelReportRes> {
  if (!conductorUrl) return { ok: false, forwarded: false, error: "no conductor URL configured" };
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (tenantId) headers["X-Ark-Tenant-Id"] = tenantId;
    const resp = await fetch(`${conductorUrl}/api/channel/${sessionId}`, {
      method: "POST",
      headers,
      body: JSON.stringify(report),
    });
    if (!resp.ok) return { ok: false, forwarded: false, error: `conductor returned ${resp.status}` };
    return { ok: true, forwarded: true };
  } catch (e: any) {
    return { ok: false, forwarded: false, error: e?.message ?? "fetch failed" };
  }
}

async function channelRelay(
  req: ChannelRelayReq,
  conductorUrl: string | null,
  tenantId?: string | null,
): Promise<ChannelRelayRes> {
  if (!conductorUrl) return { ok: false, forwarded: false };
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (tenantId) headers["X-Ark-Tenant-Id"] = tenantId;
    const resp = await fetch(`${conductorUrl}/api/relay`, {
      method: "POST",
      headers,
      body: JSON.stringify(req),
    });
    if (!resp.ok) return { ok: false, forwarded: false };
    return { ok: true, forwarded: true };
  } catch {
    return { ok: false, forwarded: false };
  }
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

export async function handleChannelRoutes(req: Request, path: string, ctx: RouteCtx): Promise<Response | null> {
  // ── Channel: report (agent → conductor via arkd) ─────────────
  if (
    req.method === "POST" &&
    path.startsWith("/channel/") &&
    !path.endsWith("/relay") &&
    !path.endsWith("/deliver")
  ) {
    const sessionId = path.split("/")[2]!;
    const report = (await req.json()) as Record<string, unknown>;
    const tenantId = req.headers.get("x-ark-tenant-id") ?? req.headers.get("X-Ark-Tenant-Id");
    return json(await channelReport(sessionId, report, ctx.getConductorUrl(), tenantId));
  }

  // ── Channel: relay (agent → agent via conductor) ─────────────
  if (req.method === "POST" && path === "/channel/relay") {
    const body = (await req.json()) as ChannelRelayReq;
    const tenantId = req.headers.get("x-ark-tenant-id") ?? req.headers.get("X-Ark-Tenant-Id");
    return json(await channelRelay(body, ctx.getConductorUrl(), tenantId));
  }

  // ── Channel: deliver (conductor → agent on this compute) ─────
  if (req.method === "POST" && path === "/channel/deliver") {
    const body = (await req.json()) as ChannelDeliverReq;
    return json(await channelDeliver(body));
  }

  return null;
}

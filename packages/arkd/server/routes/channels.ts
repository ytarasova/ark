/**
 * HTTP wrapper for the generic channel pub/sub bus.
 *
 * Exposes `POST /channel/{name}/publish` as an HTTP endpoint. The WebSocket
 * subscribe path (`WS /ws/channel/{name}`) is handled directly in server.ts
 * via `channelWebSocketHandler` from `../channel-bus.js`.
 *
 * The bus primitive (Map<channel,state>, fan-out/broadcast delivery, ring
 * buffer, zombie eviction) lives in `../channel-bus.ts`. See that file for
 * the full channel semantics documentation.
 */

import { SAFE_TMUX_NAME_RE } from "../../common/constants.js";
import { json } from "../helpers.js";
import { type RouteCtx } from "../route-ctx.js";
import { publishFromHttp } from "../channel-bus.js";

function matchPublishPath(path: string): string | null {
  const prefix = "/channel/";
  const suffix = "/publish";
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
  const inner = path.slice(prefix.length, path.length - suffix.length);
  if (inner.length === 0) return null;
  if (!SAFE_TMUX_NAME_RE.test(inner)) return null;
  return inner;
}

export async function handleChannelRoutes(req: Request, path: string, _ctx: RouteCtx): Promise<Response | null> {
  // ── Producer: POST /channel/{name}/publish ──────────────────────────────
  if (req.method === "POST" && path.startsWith("/channel/") && path.endsWith("/publish")) {
    const name = matchPublishPath(path);
    if (!name) {
      return json({ error: "invalid channel name: must match [A-Za-z0-9_-]{1,64}" }, 400);
    }
    let body: { envelope?: unknown };
    try {
      body = (await req.json()) as { envelope?: unknown };
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const env = body?.envelope;
    if (env === undefined || env === null || typeof env !== "object" || Array.isArray(env)) {
      return json({ error: "`envelope` must be a JSON object" }, 400);
    }
    const delivered = publishFromHttp(name, env as Record<string, unknown>);
    return json({ ok: true, delivered });
  }

  // WS subscribe is handled in server.ts via Bun's native upgrade path;
  // channel-level routing uses matchWsChannelPath from ../channel-bus.js.
  return null;
}

/**
 * ArkD HTTP server - runs on every compute target.
 *
 * Provides file ops, process execution, agent lifecycle (tmux),
 * system metrics, and port probing over a typed JSON-over-HTTP API.
 *
 * This file is intentionally thin: it wires up the Bun.serve loop,
 * owns the mutable per-server state (conductorUrl, workspace root,
 * auth token), and delegates each request to a route-family module
 * under ./routes/. Route handlers are plain functions that return a
 * Response or null (to let the dispatcher fall through).
 */

import { hostname, platform } from "os";
import type { HealthRes } from "../common/types.js";
import { VERSION, DEFAULT_PORT } from "../common/constants.js";
import { PathConfinementError } from "./confinement.js";
import { json, type BunLike } from "./helpers.js";
import { type ArkdOpts } from "./route-ctx.js";
import { createRouteCtx } from "./route-ctx.js";
import { setupAuth, checkAuth } from "./auth.js";
import { startControlPlane } from "./control-plane.js";
import { handleFileRoutes } from "./routes/file.js";
import { handleExecRoutes } from "./routes/exec.js";
import { handleAgentRoutes } from "./routes/agent.js";
import { handleMetricsSnapshotRoutes } from "./routes/metrics-snapshot.js";
import { handleChannelRoutes } from "./routes/channel.js";
import {
  channelWebSocketHandler,
  handleChannelRoutes as handleGenericChannelRoutes,
  matchWsChannelPath,
  type ChannelWsData,
} from "./routes/channels.js";
import { handleMiscRoutes } from "./routes/misc.js";
import { handleAttachRoutes, sweepOrphanAttachFifos, closeAllAttachStreams } from "./routes/attach.js";
import { handleProcessRoutes } from "./routes/process.js";

declare const Bun: BunLike;

export { PathConfinementError, VERSION };
export type { ArkdOpts };

export function startArkd(port = DEFAULT_PORT, opts?: ArkdOpts): { stop(): void; setConductorUrl(url: string): void } {
  // Mutable runtime config
  let conductorUrl: string | null = opts?.conductorUrl ?? process.env.ARK_CONDUCTOR_URL ?? "http://localhost:19100";
  const bindHost = opts?.hostname ?? "0.0.0.0";

  // Auth token setup -- persists token to disk and pre-computes the expected
  // header bytes for constant-time comparison.
  const arkdToken: string | null = opts?.token ?? process.env.ARK_ARKD_TOKEN ?? null;
  const expectedAuth = setupAuth(arkdToken);

  // Control plane registration + heartbeat (no-op when ARK_CONTROL_PLANE_URL unset).
  const controlPlane = startControlPlane(port);

  // RouteCtx shared with every route-family module.
  const ctx = createRouteCtx({
    workspaceRoot: opts?.workspaceRoot ?? process.env.ARK_WORKSPACE_ROOT ?? null,
    getConductorUrl: () => conductorUrl,
    setConductorUrl: (url) => {
      conductorUrl = url;
    },
  });

  const server = Bun.serve({
    port,
    hostname: bindHost,
    // Long-lived streams (e.g. /agent/attach/stream) stay open indefinitely
    // until the client disconnects. `idleTimeout: 0` disables Bun's default
    // 10s cap, which also covers slow `/snapshot` calls on loaded macOS
    // hosts where top + vm_stat + tmux + docker-stats stack past 10s.
    idleTimeout: 0,
    websocket: {
      ...channelWebSocketHandler,
      // Bun sends ping frames every `idleTimeout` seconds when sendPings
      // is true (default). 30s is short enough that every TCP / proxy /
      // SSM tunnel layer sees the connection as live and won't tear it
      // down on idle. The client's WebSocket implementation answers with
      // pong automatically -- no application-level keepalive needed.
      idleTimeout: 30,
      sendPings: true,
    },
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;

      // WebSocket upgrade for /ws/channel/{name}. Auth is required for
      // upgrades, same as for HTTP requests. The data attached here is
      // available on `ws.data` in the websocket handlers.
      if (req.method === "GET" && path.startsWith("/ws/")) {
        const channelName = matchWsChannelPath(path);
        if (channelName) {
          const authErr = checkAuth(req, path, expectedAuth);
          if (authErr) return authErr;
          const data: ChannelWsData = { channel: channelName };
          if (srv.upgrade(req, { data })) {
            // Returning undefined hands the request to the websocket
            // handler. Bun expects no Response when an upgrade succeeded.
            return undefined as unknown as Response;
          }
          return json({ error: "websocket upgrade failed" }, 400);
        }
        return json({ error: "unknown websocket path" }, 404);
      }

      try {
        // ── Health ─────────────────────────────────────────────────────
        if (req.method === "GET" && path === "/health") {
          return json<HealthRes>({
            status: "ok",
            version: VERSION,
            hostname: hostname(),
            platform: platform(),
          });
        }

        // Auth check (after health, which is exempt)
        const authErr = checkAuth(req, path, expectedAuth);
        if (authErr) return authErr;

        // Dispatch to route families. Each handler returns a Response
        // on match, or null to fall through to the next family.
        const metricsRes = await handleMetricsSnapshotRoutes(req, path, ctx);
        if (metricsRes) return metricsRes;

        const fileRes = await handleFileRoutes(req, path, ctx);
        if (fileRes) return fileRes;

        const execRes = await handleExecRoutes(req, path, ctx);
        if (execRes) return execRes;

        // Attach routes must come before the generic agent routes so
        // `/agent/attach/*` paths hit the live-attach handler first.
        const attachRes = await handleAttachRoutes(req, path);
        if (attachRes) return attachRes;

        // Generic channel pub/sub: POST /channel/{name}/publish,
        // GET /channel/{name}/subscribe. Mounted BEFORE the legacy
        // /channel/<sid> + /channel/relay + /channel/deliver routes so the
        // verb-suffixed pattern matches first.
        const genericChannelRes = await handleGenericChannelRoutes(req, path, ctx);
        if (genericChannelRes) return genericChannelRes;

        // Generic process supervisor (/process/*) is the modern replacement
        // for the tmux-only /agent/* lifecycle. Mount it before the legacy
        // agent routes so future moves to /process/spawn don't collide.
        const processRes = await handleProcessRoutes(req, path, ctx);
        if (processRes) return processRes;

        const agentRes = await handleAgentRoutes(req, path, ctx);
        if (agentRes) return agentRes;

        const channelRes = await handleChannelRoutes(req, path, ctx);
        if (channelRes) return channelRes;

        const miscRes = await handleMiscRoutes(req, path, ctx);
        if (miscRes) return miscRes;

        return new Response("Not found", { status: 404 });
      } catch (e: any) {
        if (e instanceof SyntaxError) {
          return json({ error: "invalid JSON" }, 400);
        }
        if (e instanceof PathConfinementError) {
          return json({ error: "path escapes workspace root", detail: e.message }, 403);
        }
        return json({ error: String(e.message ?? e) }, 500);
      }
    },
  });

  if (!opts?.quiet) process.stderr.write(`[arkd] listening on ${bindHost}:${port}\n`);

  // Sweep orphaned attach fifos from prior crashed runs. Best-effort + async,
  // does not gate request serving. (See packages/arkd/routes/attach.ts for
  // why these accumulate -- observed 80+ leftovers on a long-lived dev box.)
  void sweepOrphanAttachFifos();

  return {
    stop() {
      controlPlane?.stop();
      // Close any active attach streams so we don't leak fifos / `cat >> fifo`
      // writers across the next arkd start. Best-effort + fire-and-forget.
      void closeAllAttachStreams();
      server.stop();
    },
    setConductorUrl(url: string) {
      conductorUrl = url;
    },
  };
}

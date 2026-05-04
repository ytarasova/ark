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

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import { hostname, platform, homedir } from "os";
import { timingSafeEqual } from "crypto";
import type { HealthRes } from "./types.js";
import { logDebug } from "../core/observability/structured-log.js";
import {
  AUTH_EXEMPT_PATHS,
  confineToWorkspace,
  DEFAULT_PORT,
  PathConfinementError,
  VERSION,
  json,
  type ArkdOpts,
  type BunLike,
  type RouteCtx,
} from "./internal.js";
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

  // Workspace confinement root (P1-4). When set, every /file/* and /exec
  // request is restricted to paths under this directory. When unset,
  // arkd retains legacy unconfined behavior for local single-user mode.
  const workspaceRootRaw = opts?.workspaceRoot ?? process.env.ARK_WORKSPACE_ROOT ?? null;
  const workspaceRoot: string | null = workspaceRootRaw ? resolve(workspaceRootRaw) : null;
  if (workspaceRoot) {
    // Ensure the root exists so confined writes succeed out of the box.
    try {
      mkdirSync(workspaceRoot, { recursive: true });
    } catch {
      logDebug("compute", "best effort -- first real request will surface any permission error");
    }
  }

  /**
   * Enforce workspace confinement (no-op when workspaceRoot is null).
   * Returns the resolved absolute path, or throws PathConfinementError.
   */
  function confine(userPath: unknown): string {
    if (!workspaceRoot) {
      if (typeof userPath !== "string") {
        throw new PathConfinementError("path must be a string");
      }
      return userPath;
    }
    return confineToWorkspace(workspaceRoot, userPath);
  }

  // Auth token
  const arkdToken: string | null = opts?.token ?? process.env.ARK_ARKD_TOKEN ?? null;
  if (arkdToken) {
    const arkDir = join(homedir(), ".ark");
    if (!existsSync(arkDir)) mkdirSync(arkDir, { recursive: true });
    writeFileSync(join(arkDir, "arkd.token"), arkdToken, { mode: 0o600 });
  }

  // Pre-compute the expected header bytes so the timing-safe comparison
  // sees a fixed-length reference. timingSafeEqual throws on length mismatch,
  // so we pre-pad the provided header to the expected length before compare
  // and still return 401 -- this collapses "unauthorized" and "wrong length"
  // into a single timing path, removing the obvious side channel.
  const expectedAuth = arkdToken ? Buffer.from(`Bearer ${arkdToken}`) : null;

  function checkAuth(req: Request, path: string): Response | null {
    if (!arkdToken || !expectedAuth) return null;
    if (AUTH_EXEMPT_PATHS.has(path)) return null;
    let authHeader = req.headers.get("Authorization") ?? "";
    // WebSocket upgrade requests can't easily set custom headers from
    // browsers; allow the bearer token to ride in the
    // Sec-WebSocket-Protocol subprotocol header as `Bearer.<token>`.
    // This matches what `ArkdClient.subscribeToChannel` sends. The
    // value is still constant-time-compared below; subprotocol is
    // just a transport for the same token.
    if (!authHeader) {
      const subproto = req.headers.get("Sec-WebSocket-Protocol") ?? "";
      const m = subproto
        .split(",")
        .map((s) => s.trim())
        .find((s) => s.startsWith("Bearer."));
      if (m) authHeader = `Bearer ${m.slice("Bearer.".length)}`;
    }
    const providedBuf = Buffer.from(authHeader);
    // Mismatched length => definitely wrong; still run a constant-time compare
    // against a fixed-size dummy so the timing does not leak "wrong length".
    if (providedBuf.length !== expectedAuth.length) {
      timingSafeEqual(expectedAuth, expectedAuth);
      return json({ error: "Unauthorized" }, 401);
    }
    if (timingSafeEqual(providedBuf, expectedAuth)) return null;
    return json({ error: "Unauthorized" }, 401);
  }

  // Control plane registration
  const controlPlaneUrl = process.env.ARK_CONTROL_PLANE_URL;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const workerId = process.env.ARK_WORKER_ID || `worker-${hostname()}-${port}`;
  const workerCapacity = parseInt(process.env.ARK_WORKER_CAPACITY ?? "5", 10);

  if (controlPlaneUrl) {
    // Register with control plane
    const workerUrl = `http://${hostname()}:${port}`;
    const registerPayload = {
      id: workerId,
      url: workerUrl,
      capacity: workerCapacity,
      compute_name: process.env.ARK_COMPUTE_NAME || null,
      tenant_id: process.env.ARK_TENANT_ID || null,
      metadata: { hostname: hostname(), platform: platform(), port },
    };

    // Initial registration (fire and forget)
    fetch(`${controlPlaneUrl}/api/workers/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registerPayload),
    }).catch(() => {
      /* control plane not ready yet -- heartbeat will retry */
    });

    // Heartbeat every 30s
    heartbeatTimer = setInterval(() => {
      fetch(`${controlPlaneUrl}/api/workers/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: workerId }),
      }).catch(() => {
        /* control plane unreachable */
      });
    }, 30_000);
  }

  // RouteCtx shared with every route-family module.
  const ctx: RouteCtx = {
    confine,
    workspaceRoot,
    getConductorUrl: () => conductorUrl,
    setConductorUrl: (url) => {
      conductorUrl = url;
    },
  };

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
          const authErr = checkAuth(req, path);
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
        const authErr = checkAuth(req, path);
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
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      // Deregister from control plane on shutdown
      if (controlPlaneUrl) {
        fetch(`${controlPlaneUrl}/api/workers/deregister`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: workerId }),
        }).catch(() => {
          /* best effort */
        });
      }
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

/**
 * Conductor: HTTP server that receives channel reports from agents.
 *
 * Routes:
 *   POST /api/channel/:sessionId        - receive agent report
 *   POST /api/relay                     - relay message between agents
 *   GET  /api/sessions                  - list sessions
 *   GET  /api/sessions/:id              - get session detail
 *   GET  /api/sessions/:id/stdio        - read tracks/:id/stdio.log (raw text)
 *   GET  /api/sessions/:id/transcript   - read tracks/:id/transcript.jsonl (ndjson)
 *   GET  /api/events/:id                - get events
 *   POST /hooks/github/merge            - GitHub PR merge webhook (auto-rollback)
 *   GET  /health                        - health check
 *
 * This file is a thin composing facade. The route-handler bodies live in
 * sibling modules:
 *
 *   - tenant.ts                  tenant resolution + `appForRequest`
 *   - report-pipeline.ts         `handleReport` -- shared by channel + hooks
 *   - hook-status-handler.ts     `POST /hooks/status`
 *   - rest-api-handler.ts        `GET /api/sessions/:id/...` + tree SSE
 *   - pr-merge-webhook.ts        `POST /hooks/github/merge`
 *   - worker-handlers.ts         `POST /api/workers/{register,heartbeat,...}`
 *   - tenant-policy-handlers.ts  `GET/PUT/DELETE /api/tenant/polic*`
 *   - llm-proxy.ts               `/v1/chat/completions` + `/v1/models` proxy
 *   - pollers.ts                 schedule/PR-review/PR-merge/issue pollers
 *   - deliver-to-channel.ts      free-function helper (kept at top-level for
 *                                back-compat with integration imports)
 */

// Bun global type declaration (avoids requiring @types/bun as a dependency)
declare const Bun: {
  serve(options: { port: number; hostname: string; fetch(req: Request): Promise<Response> | Response }): {
    stop(closeActiveConnections?: boolean): void;
  };
};

import type { Session } from "../../types/index.js";
import type { AppContext } from "../app.js";
import type { OutboundMessage } from "./channel-types.js";
import { logInfo } from "../observability/structured-log.js";
import { DEFAULT_CONDUCTOR_PORT, DEFAULT_CONDUCTOR_HOST } from "../constants.js";
import { appForRequest } from "./tenant.js";
import { handleReport } from "./report-pipeline.js";
import { handleHookStatus } from "./hook-status-handler.js";
import { handleRestApi } from "./rest-api-handler.js";
import { handlePRMergeWebhook } from "./pr-merge-webhook.js";
import {
  handleWorkerRegister,
  handleWorkerHeartbeat,
  handleWorkerDeregister,
  handleWorkerList,
} from "./worker-handlers.js";
import {
  handleTenantPolicyGet,
  handleTenantPolicySet,
  handleTenantPolicyDelete,
  handleTenantPolicyList,
} from "./tenant-policy-handlers.js";
import { proxyToRouter } from "./llm-proxy.js";
import { startPollers } from "./pollers.js";
import { deliverToChannel } from "./deliver-to-channel.js";

const DEFAULT_PORT = DEFAULT_CONDUCTOR_PORT;

/** Extract a path segment by index, returning null if missing. */
function extractPathSegment(path: string, index: number): string | null {
  return path.split("/")[index] ?? null;
}

export interface ConductorOptions {
  quiet?: boolean;
  issueLabel?: string;
  issueAutoDispatch?: boolean;
}

export interface ConductorHandle {
  stop(): void;
}

/**
 * Conductor -- HTTP server + background pollers.
 *
 * The class is now a composing facade: it owns lifecycle (start/stop of
 * Bun.serve + poller timers) and routes each request to a handler module.
 * Route-handler bodies live in sibling files to keep this file a small
 * dispatch table.
 *
 * Dependencies are injected via `AppContext`. There is no module-level
 * singleton; `deliverToChannel` is a free function that takes `app`
 * explicitly (kept re-exported here for back-compat with existing imports).
 */
export class Conductor {
  private readonly app: AppContext;
  private readonly port: number;
  private readonly opts: ConductorOptions;
  private server: { stop(closeActiveConnections?: boolean): void } | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];

  constructor(app: AppContext, port: number = DEFAULT_PORT, opts: ConductorOptions = {}) {
    this.app = app;
    this.port = port;
    this.opts = opts;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  start(): ConductorHandle {
    this.server = Bun.serve({
      port: this.port,
      hostname: DEFAULT_CONDUCTOR_HOST,
      fetch: (req) => this.fetch(req),
    });

    if (!this.opts.quiet) logInfo("conductor", `Ark conductor listening on localhost:${this.port}`);

    this.timers = startPollers(this.app, {
      issueLabel: this.opts.issueLabel,
      issueAutoDispatch: this.opts.issueAutoDispatch,
    });

    return {
      stop: () => this.stop(),
    };
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    // Force-close active connections so the port releases immediately and
    // a fresh Conductor can bind to the same port (test scenarios).
    this.server?.stop(true);
    this.server = null;
  }

  // ── Top-level router ─────────────────────────────────────────────────────

  private async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (req.method === "POST" && path.startsWith("/api/channel/")) {
        const sessionId = extractPathSegment(path, 3);
        if (!sessionId) return Response.json({ error: "missing session id" }, { status: 400 });
        return this.handleChannelReport(req, sessionId);
      }

      if (req.method === "POST" && path === "/api/relay") {
        return this.handleAgentRelay(req);
      }

      if (req.method === "POST" && path === "/hooks/status") {
        return handleHookStatus(this.app, req, url);
      }

      if (req.method === "POST" && path === "/hooks/github/merge") {
        return handlePRMergeWebhook(this.app, req);
      }

      // ── Worker management (hosted control plane) ──────────────────
      if (req.method === "POST" && path === "/api/workers/register") {
        return handleWorkerRegister(this.app, req);
      }
      if (req.method === "POST" && path === "/api/workers/heartbeat") {
        return handleWorkerHeartbeat(this.app, req);
      }
      if (req.method === "POST" && path === "/api/workers/deregister") {
        return handleWorkerDeregister(this.app, req);
      }
      if (req.method === "GET" && path === "/api/workers") {
        return handleWorkerList(this.app);
      }

      // ── Tenant policy management (hosted control plane) ────────────
      if (path.startsWith("/api/tenant/polic")) {
        if (req.method === "GET" && path === "/api/tenant/policies") {
          return handleTenantPolicyList(this.app);
        }
        if (path.startsWith("/api/tenant/policy/")) {
          const tenantId = extractPathSegment(path, 4);
          if (!tenantId) return Response.json({ error: "missing tenant id" }, { status: 400 });
          if (req.method === "GET") return handleTenantPolicyGet(this.app, tenantId);
          if (req.method === "PUT") return handleTenantPolicySet(this.app, req, tenantId);
          if (req.method === "DELETE") return handleTenantPolicyDelete(this.app, tenantId);
        }
      }

      // ── LLM proxy: forward to router ──────────────────────────
      if (req.method === "POST" && path === "/v1/chat/completions") {
        return proxyToRouter(this.app, req, "/v1/chat/completions");
      }
      if (req.method === "GET" && path === "/v1/models") {
        return proxyToRouter(this.app, req, "/v1/models");
      }

      if (req.method === "GET") {
        return handleRestApi(this.app, req, path);
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }

  // ── Channel + relay handlers (kept on the class: tiny and they
  //    touch `this.app` directly rather than the tenant-scoped one)

  private async handleChannelReport(req: Request, sessionId: string): Promise<Response> {
    const resolved = await appForRequest(this.app, req);
    if (resolved.ok === false) return resolved.response;
    const report = (await req.json()) as OutboundMessage;
    await handleReport(resolved.app, sessionId, report);
    return Response.json({ status: "ok" });
  }

  private async handleAgentRelay(req: Request): Promise<Response> {
    const resolved = await appForRequest(this.app, req);
    if (resolved.ok === false) return resolved.response;
    const { from, target, message } = (await req.json()) as {
      from: string;
      target: string;
      message: string;
    };
    const scoped = resolved.app;
    const targetSession = await scoped.sessions.get(target);
    if (targetSession) {
      const channelPort = scoped.sessions.channelPort(target);
      const payload = { type: "steer", message, from, sessionId: target };
      await deliverToChannel(this.app, targetSession as Session, channelPort, payload);
    }
    return Response.json({ status: "relayed" });
  }
}

// ── Public entry points (thin wrappers over the Conductor class) ───────────

/**
 * Start the conductor HTTP server. Returns a handle with a `stop()` method.
 *
 * Prefer instantiating `Conductor` directly when you need access to the
 * running instance; this thin wrapper exists for the launcher + tests that
 * only need the stop handle.
 */
export function startConductor(app: AppContext, port = DEFAULT_PORT, opts?: ConductorOptions): ConductorHandle {
  const c = new Conductor(app, port, opts);
  return c.start();
}

// Re-exported so existing integration imports keep working:
//   `import { deliverToChannel } from "../conductor/conductor.js"`
export { deliverToChannel } from "./deliver-to-channel.js";

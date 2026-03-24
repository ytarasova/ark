/**
 * Conductor: HTTP server that receives channel reports from agents.
 *
 * Routes:
 *   POST /api/channel/:sessionId - receive agent report
 *   POST /api/relay              - relay message between agents
 *   GET  /api/sessions           - list sessions
 *   GET  /api/sessions/:id       - get session detail
 *   GET  /api/events/:id         - get events
 *   GET  /health                 - health check
 */

// Bun global type declaration (avoids requiring @types/bun as a dependency)
declare const Bun: {
  serve(options: {
    port: number;
    hostname: string;
    fetch(req: Request): Promise<Response> | Response;
  }): { stop(): void };
};

import * as store from "./store.js";
import * as session from "./session.js";
import * as flow from "./flow.js";
import { eventBus } from "./hooks.js";
import type { OutboundMessage } from "./channel-types.js";
import { getProvider } from "../compute/index.js";

const DEFAULT_PORT = 19100;

export function startConductor(port = DEFAULT_PORT): void {
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      try {
        // Agent channel reports
        if (req.method === "POST" && path.startsWith("/api/channel/")) {
          const sessionId = path.split("/")[3]!;
          const report = (await req.json()) as OutboundMessage;
          handleReport(sessionId, report);
          return Response.json({ status: "ok" });
        }

        // Agent-to-agent relay
        if (req.method === "POST" && path === "/api/relay") {
          const { from, target, message } = (await req.json()) as {
            from: string;
            target: string;
            message: string;
          };
          const targetSession = store.getSession(target);
          if (targetSession) {
            const channelPort = store.sessionChannelPort(target);
            try {
              await fetch(`http://localhost:${channelPort}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  type: "steer",
                  message,
                  from,
                  sessionId: target,
                }),
              });
            } catch {
              /* target channel not reachable */
            }
          }
          return Response.json({ status: "relayed" });
        }

        // REST API
        if (req.method === "GET") {
          if (path === "/api/sessions")
            return Response.json(store.listSessions());
          if (path.startsWith("/api/sessions/")) {
            const id = path.split("/")[3]!;
            const s = store.getSession(id);
            return s
              ? Response.json(s)
              : Response.json({ error: "not found" }, { status: 404 });
          }
          if (path.startsWith("/api/events/")) {
            const id = path.split("/")[3]!;
            return Response.json(store.getEvents(id));
          }
          if (path === "/health") {
            return Response.json({
              status: "ok",
              sessions: store.listSessions().length,
            });
          }
        }

        return new Response("Not found", { status: 404 });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    },
  });

  console.log(`Ark conductor listening on localhost:${port}`);

  // Background metrics polling - every 30 seconds
  let polling = false;
  setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const computes = store.listCompute({ status: "running" });
      for (const compute of computes) {
        const provider = getProvider(compute.provider);
        if (!provider) continue;
        try {
          // Fetch metrics (results are used by TUI which reads from provider directly)
          await provider.getMetrics(compute);

          // Probe ports for running sessions on this compute
          const sessions = store.listSessions({ status: "running" });
          for (const s of sessions) {
            if (s.compute_name !== compute.name) continue;
            const ports = (s.config as any)?.ports ?? [];
            if (ports.length > 0) {
              const status = await provider.probePorts(compute, ports);
              // Update session config with port status
              store.updateSession(s.id, {
                config: { ...s.config, ports: status },
              });
            }
          }
        } catch { /* compute unreachable, skip */ }
      }
    } catch { /* ignore polling errors */ } finally { polling = false; }
  }, 30_000);
}

function handleReport(sessionId: string, report: OutboundMessage): void {
  // Log event
  store.logEvent(sessionId, `agent_${report.type}`, {
    stage: report.stage,
    actor: "agent",
    data: report as unknown as Record<string, unknown>,
  });

  // Store as message for the TUI chat view
  const content = report.type === "completed" ? (report as any).summary
    : report.type === "question" ? (report as any).question
    : report.type === "error" ? (report as any).error
    : (report as any).message ?? JSON.stringify(report);
  store.addMessage({
    session_id: sessionId,
    role: "agent",
    content,
    type: report.type,
  });

  // Emit to event bus
  eventBus.emit(`agent_${report.type}`, sessionId, {
    stage: report.stage,
    data: report as unknown as Record<string, unknown>,
  });

  // Handle by type
  switch (report.type) {
    case "completed": {
      store.updateSession(sessionId, { status: "ready", session_id: null });
      const advResult = session.advance(sessionId);
      if (advResult.ok) {
        const updated = store.getSession(sessionId);
        if (updated && updated.status === "ready" && updated.stage) {
          const nextAction = flow.getStageAction(
            updated.flow,
            updated.stage
          );
          if (nextAction.type === "agent" || nextAction.type === "fork") {
            session.dispatch(sessionId);
          }
        }
      }
      break;
    }
    case "question":
      store.updateSession(sessionId, {
        status: "waiting",
        breakpoint_reason:
          (report as any).question ?? (report as any).message,
      });
      break;
    case "error":
      store.updateSession(sessionId, {
        status: "failed",
        error: (report as any).error ?? (report as any).message,
      });
      break;
    case "progress":
      // Just log, no state change
      break;
  }
}

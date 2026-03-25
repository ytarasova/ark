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
import { parseTranscriptUsage } from "./claude.js";
import { indexSession } from "./search.js";
import { listSchedules, cronMatches, updateScheduleLastRun } from "./schedule.js";
import { validateSignature, handleGitHubWebhook } from "./github-webhook.js";

const DEFAULT_PORT = 19100;

export function startConductor(port = DEFAULT_PORT, opts?: { quiet?: boolean }): { stop(): void } {
  const server = Bun.serve({
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

        // Hook-based agent status (separate from channel protocol)
        if (req.method === "POST" && path === "/hooks/status") {
          const sessionId = url.searchParams.get("session");
          if (!sessionId) return Response.json({ error: "missing session param" }, { status: 400 });

          const s = store.getSession(sessionId);
          if (!s) return Response.json({ error: "session not found" }, { status: 404 });

          const payload = await req.json() as Record<string, unknown>;
          const event = String(payload.hook_event_name ?? "");

          const statusMap: Record<string, string> = {
            SessionStart: "running",
            UserPromptSubmit: "running",
            Stop: "ready",
            StopFailure: "failed",
            SessionEnd: "completed",
          };

          let newStatus = statusMap[event];

          if (event === "Notification") {
            const matcher = String(payload.matcher ?? "");
            if (matcher.includes("permission_prompt") || matcher.includes("idle_prompt")) {
              newStatus = "waiting";
            }
          }

          // Log the hook event
          store.logEvent(sessionId, "hook_status", {
            actor: "hook",
            data: { event, ...payload } as Record<string, unknown>,
          });

          if (newStatus) {
            const updates: Partial<store.Session> = { status: newStatus as any };
            if (newStatus === "failed") {
              updates.error = String(payload.error ?? payload.error_details ?? "unknown error");
            }
            store.updateSession(sessionId, updates);

            eventBus.emit("hook_status", sessionId, {
              data: { event, status: newStatus, ...payload } as Record<string, unknown>,
            });
          }

          // Track token usage from transcript on Stop and SessionEnd
          const transcriptPath = payload.transcript_path as string | undefined;
          if (transcriptPath && (event === "Stop" || event === "SessionEnd")) {
            try {
              const usage = parseTranscriptUsage(transcriptPath);
              if (usage.total_tokens > 0) {
                const currentSession = store.getSession(sessionId);
                if (currentSession) {
                  const config = typeof currentSession.config === "string"
                    ? JSON.parse(currentSession.config) : (currentSession.config ?? {});
                  config.usage = usage;
                  store.updateSession(sessionId, { config });
                }
              }
            } catch { /* transcript parsing failure shouldn't block status update */ }

              // Index transcript for FTS5 search
              try {
                indexSession(transcriptPath, sessionId);
              } catch { /* indexing failure shouldn't block status update */ }
          }

          return Response.json({ status: "ok", mapped: newStatus ?? "no-op" });
        }

        // GitHub webhook for PR review events
        if (req.method === "POST" && path === "/api/webhook/github") {
          const secret = process.env.ARK_GITHUB_WEBHOOK_SECRET;
          if (!secret) return Response.json({ error: "ARK_GITHUB_WEBHOOK_SECRET not set" }, { status: 500 });

          const body = await req.text();
          const sig = req.headers.get("x-hub-signature-256") ?? "";

          if (!validateSignature(body, sig, secret)) {
            return Response.json({ error: "invalid signature" }, { status: 401 });
          }

          const event = req.headers.get("x-github-event") ?? "";
          const payload = JSON.parse(body);
          const result = await handleGitHubWebhook(event, payload);

          return Response.json(result);
        }

        return new Response("Not found", { status: 404 });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    },
  });

  if (!opts?.quiet) console.log(`Ark conductor listening on localhost:${port}`);

  // Schedule poller — check every 60 seconds
  setInterval(async () => {
    try {
      const schedules = listSchedules().filter(s => s.enabled);
      const now = new Date();
      for (const sched of schedules) {
        if (!cronMatches(sched.cron, now)) continue;
        // Skip if already ran this minute
        if (sched.last_run) {
          const lastRun = new Date(sched.last_run);
          if (lastRun.getMinutes() === now.getMinutes() &&
              lastRun.getHours() === now.getHours() &&
              lastRun.getDate() === now.getDate()) continue;
        }
        try {
          const s = session.startSession({
            summary: sched.summary ?? `Scheduled: ${sched.id}`,
            repo: sched.repo ?? undefined,
            workdir: sched.workdir ?? undefined,
            flow: sched.flow,
            compute_name: sched.compute_name ?? undefined,
            group_name: sched.group_name ?? undefined,
          });
          await session.dispatch(s.id);
          updateScheduleLastRun(sched.id);
          store.logEvent(s.id, "scheduled_dispatch", {
            actor: "scheduler",
            data: { schedule_id: sched.id, cron: sched.cron },
          });
        } catch { /* dispatch failure shouldn't crash the poller */ }
      }
    } catch { /* ignore polling errors */ }
  }, 60_000);

  return server;
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

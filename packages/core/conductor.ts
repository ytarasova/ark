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
import { indexSession } from "./search.js";
import { listSchedules, cronMatches, updateScheduleLastRun } from "./schedule.js";
import { pollPRReviews } from "./pr-poller.js";
import { ArkdClient } from "../arkd/client.js";

const DEFAULT_PORT = 19100;

/** Interval between schedule and PR review poll ticks */
const POLL_INTERVAL_MS = 60_000;

/** Extract a path segment by index, returning null if missing. */
function extractPathSegment(path: string, index: number): string | null {
  return path.split("/")[index] ?? null;
}

// ── Route handlers ──────────────────────────────────────────────────────────

async function handleChannelReport(req: Request, sessionId: string): Promise<Response> {
  const report = (await req.json()) as OutboundMessage;
  handleReport(sessionId, report);
  return Response.json({ status: "ok" });
}

async function handleAgentRelay(req: Request): Promise<Response> {
  const { from, target, message } = (await req.json()) as {
    from: string;
    target: string;
    message: string;
  };
  const targetSession = store.getSession(target);
  if (targetSession) {
    const channelPort = store.sessionChannelPort(target);
    const payload = { type: "steer", message, from, sessionId: target };
    await deliverToChannel(targetSession, channelPort, payload);
  }
  return Response.json({ status: "relayed" });
}

async function handleHookStatus(req: Request, url: URL): Promise<Response> {
  const sessionId = url.searchParams.get("session");
  if (!sessionId) return Response.json({ error: "missing session param" }, { status: 400 });

  const s = store.getSession(sessionId);
  if (!s) return Response.json({ error: "session not found" }, { status: 404 });

  const payload = await req.json() as Record<string, unknown>;
  const event = String(payload.hook_event_name ?? "");

  // Delegate business logic to session.ts
  const result = session.applyHookStatus(s, event, payload);

  // Apply events
  for (const evt of result.events ?? []) {
    store.logEvent(sessionId, evt.type, evt.opts);
  }

  // Apply store updates
  if (result.updates) {
    store.updateSession(sessionId, result.updates);
  }

  // Emit to event bus
  if (result.newStatus) {
    eventBus.emit("hook_status", sessionId, {
      data: { event, status: result.newStatus, ...payload } as Record<string, unknown>,
    });
  }

  // Apply usage data
  if (result.usage) {
    const currentSession = store.getSession(sessionId);
    if (currentSession) {
      const config = typeof currentSession.config === "string"
        ? JSON.parse(currentSession.config) : (currentSession.config ?? {});
      config.usage = result.usage;
      store.updateSession(sessionId, { config });
    }
  }

  // Index transcript
  if (result.shouldIndex && result.indexTranscript) {
    try {
      indexSession(result.indexTranscript.transcriptPath, result.indexTranscript.sessionId);
    } catch (e: any) { console.error("transcript indexing failed:", e?.message ?? e); }
  }

  return Response.json({ status: "ok", mapped: result.newStatus ?? "no-op" });
}

function handleRestApi(path: string): Response {
  if (path === "/api/sessions")
    return Response.json(store.listSessions());
  if (path.startsWith("/api/sessions/")) {
    const id = extractPathSegment(path, 3);
    if (!id) return Response.json({ error: "missing session id" }, { status: 400 });
    const s = store.getSession(id);
    return s
      ? Response.json(s)
      : Response.json({ error: "not found" }, { status: 404 });
  }
  if (path.startsWith("/api/events/")) {
    const id = extractPathSegment(path, 3);
    if (!id) return Response.json({ error: "missing session id" }, { status: 400 });
    return Response.json(store.getEvents(id));
  }
  if (path === "/health") {
    return Response.json({
      status: "ok",
      sessions: store.listSessions().length,
    });
  }
  return new Response("Not found", { status: 404 });
}

// ── Server ──────────────────────────────────────────────────────────────────

export function startConductor(port = DEFAULT_PORT, opts?: { quiet?: boolean }): { stop(): void } {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      try {
        if (req.method === "POST" && path.startsWith("/api/channel/")) {
          const sessionId = extractPathSegment(path, 3);
          if (!sessionId) return Response.json({ error: "missing session id" }, { status: 400 });
          return handleChannelReport(req, sessionId);
        }

        if (req.method === "POST" && path === "/api/relay") {
          return handleAgentRelay(req);
        }

        if (req.method === "POST" && path === "/hooks/status") {
          return handleHookStatus(req, url);
        }

        if (req.method === "GET") {
          return handleRestApi(path);
        }

        return new Response("Not found", { status: 404 });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    },
  });

  if (!opts?.quiet) console.log(`Ark conductor listening on localhost:${port}`);

  // Schedule poller — check every 60 seconds
  const scheduleTimer = setInterval(async () => {
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
        } catch (e: any) { console.error(`scheduled dispatch failed for ${sched.id}:`, e?.message ?? e); }
      }
    } catch (e: any) { console.error("schedule polling error:", e?.message ?? e); }
  }, POLL_INTERVAL_MS);

  // PR review poller - check every 60 seconds
  const prTimer = setInterval(async () => {
    try { await pollPRReviews(); } catch (e: any) { console.error("PR review polling error:", e?.message ?? e); }
  }, POLL_INTERVAL_MS);

  return {
    stop() {
      clearInterval(scheduleTimer);
      clearInterval(prTimer);
      server.stop();
    },
  };
}

/**
 * Deliver a message to a session's channel, using arkd if available.
 * Falls back to direct HTTP to the channel port for local sessions.
 */
export async function deliverToChannel(
  targetSession: store.Session,
  channelPort: number,
  payload: Record<string, unknown>,
): Promise<void> {
  // Try arkd delivery first (works for both local and remote)
  const computeName = targetSession.compute_name || "local";
  const compute = store.getCompute(computeName);
  if (compute) {
    const provider = getProvider(compute.provider);
    if (provider && typeof (provider as any).getArkdUrl === "function") {
      try {
        const arkdUrl = (provider as any).getArkdUrl(compute);
        const client = new ArkdClient(arkdUrl);
        const result = await client.channelDeliver({ channelPort, payload });
        if (result.delivered) return;
      } catch (e: any) { /* arkd not available — fall through to direct HTTP */ }
    }
  }

  // Fallback: direct HTTP to channel port (local only)
  try {
    await fetch(`http://localhost:${channelPort}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e: any) { /* channel not reachable — expected when agent hasn't started channel yet */ }
}

function handleReport(sessionId: string, report: OutboundMessage): void {
  // Delegate business logic to session.ts
  const result = session.applyReport(sessionId, report);

  // Log events
  for (const evt of result.logEvents ?? []) {
    store.logEvent(sessionId, evt.type, evt.opts);
  }

  // Store message for TUI chat view
  if (result.message) {
    store.addMessage({
      session_id: sessionId,
      role: result.message.role,
      content: result.message.content,
      type: result.message.type,
    });
  }

  // Emit bus events
  for (const evt of result.busEvents ?? []) {
    eventBus.emit(evt.type, evt.sessionId, evt.data);
  }

  // Apply store updates
  if (Object.keys(result.updates).length > 0) {
    store.updateSession(sessionId, result.updates);
  }

  // Handle advance + auto-dispatch for completed reports
  if (result.shouldAdvance) {
    const advResult = session.advance(sessionId);
    if (result.shouldAutoDispatch && advResult.ok) {
      const updated = store.getSession(sessionId);
      if (updated && updated.status === "ready" && updated.stage) {
        const nextAction = flow.getStageAction(updated.flow, updated.stage);
        if (nextAction.type === "agent" || nextAction.type === "fork") {
          session.dispatch(sessionId);
        }
      }
    }
  }

  // PR URL detection
  if (result.prUrl) {
    store.updateSession(sessionId, { pr_url: result.prUrl });
    store.logEvent(sessionId, "pr_detected", {
      actor: "agent",
      data: { pr_url: result.prUrl },
    });
  }
}

/**
 * Conductor: HTTP server that receives channel reports from agents.
 *
 * Routes:
 *   POST /api/channel/:sessionId - receive agent report
 *   POST /api/relay              - relay message between agents
 *   GET  /api/sessions           - list sessions
 *   GET  /api/sessions/:id       - get session detail
 *   GET  /api/events/:id         - get events
 *   POST /hooks/github/merge     - GitHub PR merge webhook (auto-rollback)
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

import type { Session } from "../../types/index.js";
import type { AppContext } from "../app.js";
import * as session from "../services/session-orchestration.js";
import { eventBus } from "../hooks.js";
import type { OutboundMessage } from "./channel-types.js";
import { getProvider } from "../../compute/index.js";
import { indexSession } from "../search/search.js";
import { listSchedules, cronMatches, updateScheduleLastRun } from "../schedule.js";
import { pollPRReviews } from "../integrations/pr-poller.js";
import { pollIssues } from "../integrations/issue-poller.js";
import { ArkdClient } from "../../arkd/client.js";
import { safeAsync } from "../safe.js";
import { addEntry } from "../ledger.js";
import { logError, logInfo, logWarn } from "../observability/structured-log.js";
import { sendOSNotification } from "../notify.js";
import { watchMergedPR, type RollbackConfig } from "../integrations/rollback.js";
import { emitStageSpanEnd, emitSessionSpanEnd, flushSpans } from "../observability/otlp.js";
import { DEFAULT_CONDUCTOR_PORT, DEFAULT_CONDUCTOR_HOST, DEFAULT_CHANNEL_BASE_URL } from "../constants.js";

const DEFAULT_PORT = DEFAULT_CONDUCTOR_PORT;

/** Interval between schedule and PR review poll ticks */
const POLL_INTERVAL_MS = 60_000;

/** Module-level AppContext set by startConductor(). Used by all handler functions. */
let _app: AppContext;

/** Extract a path segment by index, returning null if missing. */
function extractPathSegment(path: string, index: number): string | null {
  return path.split("/")[index] ?? null;
}

/**
 * Extract tenant id from an inbound HTTP request.
 * Priority:
 *   1. Authorization Bearer header in the format `ark_<tenantId>_<secret>`
 *   2. `X-Ark-Tenant-Id` header (direct)
 *   3. `"default"` fallback (local single-tenant mode)
 */
function extractTenantId(req: Request): string {
  const auth = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (auth) {
    const match = /^Bearer\s+ark_([^_]+)_/i.exec(auth);
    if (match && match[1]) return match[1];
  }
  const hdr = req.headers.get("x-ark-tenant-id") ?? req.headers.get("X-Ark-Tenant-Id");
  if (hdr) return hdr;
  return "default";
}

/** Return a tenant-scoped AppContext view for this request. */
function appForRequest(req: Request): AppContext {
  return _app.forTenant(extractTenantId(req));
}

// ── Route handlers ──────────────────────────────────────────────────────────

async function handleChannelReport(req: Request, sessionId: string): Promise<Response> {
  const report = (await req.json()) as OutboundMessage;
  const scoped = appForRequest(req);
  await handleReport(scoped, sessionId, report);
  return Response.json({ status: "ok" });
}

async function handleAgentRelay(req: Request): Promise<Response> {
  const { from, target, message } = (await req.json()) as {
    from: string;
    target: string;
    message: string;
  };
  const scoped = appForRequest(req);
  const targetSession = scoped.sessions.get(target);
  if (targetSession) {
    const channelPort = scoped.sessions.channelPort(target);
    const payload = { type: "steer", message, from, sessionId: target };
    await deliverToChannel(targetSession as Session, channelPort, payload);
  }
  return Response.json({ status: "relayed" });
}

async function handleHookStatus(req: Request, url: URL): Promise<Response> {
  const sessionId = url.searchParams.get("session");
  if (!sessionId) return Response.json({ error: "missing session param" }, { status: 400 });

  const app = appForRequest(req);
  const s = app.sessions.get(sessionId);
  if (!s) return Response.json({ error: "session not found" }, { status: 404 });

  const payload = await req.json() as Record<string, unknown>;
  const event = String(payload.hook_event_name ?? "");

  // Guardrail evaluation for PreToolUse events
  if (event === "PreToolUse") {
    const toolName = String(payload.tool_name ?? "");
    const toolInput = (payload.tool_input ?? {}) as Record<string, any>;
    const { evaluateToolCall } = await import("../session/guardrails.js");
    const evalResult = evaluateToolCall(toolName, toolInput);

    if (evalResult.action === "block") {
      app.events.log(sessionId, "guardrail_blocked", {
        actor: "system",
        data: { tool: toolName, pattern: evalResult.rule?.pattern, input: toolInput },
      });
    } else if (evalResult.action === "warn") {
      app.events.log(sessionId, "guardrail_warning", {
        actor: "system",
        data: { tool: toolName, pattern: evalResult.rule?.pattern },
      });
    }

    return Response.json({ status: "ok", guardrail: evalResult.action });
  }

  // Delegate business logic to session.ts
  const result = session.applyHookStatus(app, s, event, payload);

  // Apply events
  for (const evt of result.events ?? []) {
    app.events.log(sessionId, evt.type, evt.opts);
  }

  // Apply store updates
  if (result.updates) {
    app.sessions.update(sessionId, result.updates);
  }

  // On-failure retry loop: if the stage has on_failure: "retry(N)", attempt retry + re-dispatch
  if (result.shouldRetry && result.newStatus === "failed") {
    const retryResult = session.retryWithContext(app, sessionId, {
      maxRetries: result.retryMaxRetries,
    });
    if (retryResult.ok) {
      logInfo("conductor", `on_failure retry (hook) triggered for ${sessionId}: ${retryResult.message}`);
      eventBus.emit("hook_status", sessionId, {
        data: { event, status: "ready", retry: true, ...payload } as Record<string, unknown>,
      });
      session.dispatch(app, sessionId).catch(err => {
        logError("conductor", `on_failure retry dispatch (hook) failed for ${sessionId}: ${err?.message ?? err}`);
      });
      return Response.json({ status: "ok", mapped: "retry" });
    }
    // Max retries exhausted -- fall through to normal failure handling
    logWarn("conductor", `on_failure retry (hook) exhausted for ${sessionId}: ${retryResult.message}`);
  }

  // Emit to event bus
  if (result.newStatus) {
    eventBus.emit("hook_status", sessionId, {
      data: { event, status: result.newStatus, ...payload } as Record<string, unknown>,
    });

    // Clean up provider resources on terminal states (stop container, remove worktree, etc.)
    if (result.newStatus === "completed" || result.newStatus === "failed") {
      session.cleanupOnTerminal(app, sessionId);
      // Close OTLP spans for terminal states
      emitStageSpanEnd(sessionId, { status: result.newStatus });
      emitSessionSpanEnd(sessionId, { status: result.newStatus });
      flushSpans();
      // OS notification is handled by handleReport to avoid duplicates

      // Record eval in knowledge graph
      try {
        const { evaluateSession } = await import("../knowledge/evals.js");
        const freshSession = app.sessions.get(sessionId);
        if (freshSession) evaluateSession(app, freshSession);
      } catch { /* skip eval on error */ }
    }
  }

  // Auto-advance for SessionEnd fallback on auto-gate sessions
  if (result.shouldAdvance) {
    await session.mediateStageHandoff(app, sessionId, {
      autoDispatch: result.shouldAutoDispatch,
      source: "hook_status",
    });
  }

  // Index transcript
  if (result.shouldIndex && result.indexTranscript) {
    await safeAsync("transcript indexing", async () => {
      indexSession(app, result.indexTranscript!.transcriptPath, result.indexTranscript!.sessionId);
    });
  }

  // Track progress in conductor ledger
  if (result.newStatus) {
    try { addEntry(app, "default", "progress", `Session ${sessionId} status: ${result.newStatus}`, sessionId); } catch { /* skip ledger on error */ }
  }

  return Response.json({ status: "ok", mapped: result.newStatus ?? "no-op" });
}

function handleRestApi(path: string): Response {
  if (path === "/api/sessions")
    return Response.json(_app.sessions.list());
  if (path.startsWith("/api/sessions/")) {
    const id = extractPathSegment(path, 3);
    if (!id) return Response.json({ error: "missing session id" }, { status: 400 });
    const s = _app.sessions.get(id);
    return s
      ? Response.json(s)
      : Response.json({ error: "not found" }, { status: 404 });
  }
  if (path.startsWith("/api/events/")) {
    const id = extractPathSegment(path, 3);
    if (!id) return Response.json({ error: "missing session id" }, { status: 400 });
    return Response.json(_app.events.list(id));
  }
  if (path === "/health") {
    return Response.json({
      status: "ok",
      sessions: _app.sessions.list().length,
    });
  }
  return new Response("Not found", { status: 404 });
}

/** GitHub PR merge webhook payload (subset of fields we use). */
interface GitHubPRWebhookPayload {
  action?: string;
  pull_request?: {
    merged?: boolean;
    html_url?: string;
    merge_commit_sha?: string;
    number?: number;
    title?: string;
    head?: { ref?: string };
    base?: { ref?: string };
  };
  repository?: {
    full_name?: string;
    name?: string;
    owner?: { login?: string };
  };
}

async function handlePRMergeWebhook(req: Request): Promise<Response> {
  const payload = await req.json() as GitHubPRWebhookPayload;
  if (payload.action !== "closed" || !payload.pull_request?.merged) {
    return Response.json({ status: "ignored" });
  }

  const pr = payload.pull_request;
  const repo = payload.repository;

  // Guard against incomplete webhook payloads
  if (!repo?.owner?.login || !repo?.name || !pr?.head?.ref || !pr?.base?.ref || !pr?.merge_commit_sha) {
    return Response.json({ status: "incomplete_payload" }, { status: 400 });
  }

  // Find Ark session by branch or PR URL
  const sessions = _app.sessions.list();
  const matchedSession = sessions.find(s => {
    return s.config?.github_url === pr.html_url || s.branch === pr.head?.ref;
  });

  if (!matchedSession) return Response.json({ status: "no_session" });

  const config: RollbackConfig = _app.rollbackConfig ?? {
    enabled: false, timeout: 600, on_timeout: "ignore", auto_merge: false, health_url: null,
  };

  if (!config.enabled) return Response.json({ status: "rollback_disabled" });

  const ghToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const fetcher = async (sha: string) => {
    const res = await fetch(
      `https://api.github.com/repos/${repo.full_name}/commits/${sha}/check-suites`,
      { headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" } },
    );
    return res.json() as Promise<{ check_suites: import("./rollback.js").CheckSuiteResult[] }>;
  };

  const healthFetcher = config.health_url
    ? async () => { try { const res = await fetch(config.health_url!); return res.ok; } catch { return false; } }
    : undefined;

  const onRevert = async (revertPayload: import("./rollback.js").RevertPayload) => {
    await fetch(`https://api.github.com/repos/${repo?.full_name}/pulls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify(revertPayload),
    });
  };

  watchMergedPR(_app, {
    sessionId: matchedSession.id, sha: pr.merge_commit_sha, owner: repo.owner.login,
    repo: repo.name, prNumber: pr.number, prTitle: pr.title,
    branch: pr.head.ref, baseBranch: pr.base.ref,
    config, fetcher, healthFetcher, onRevert,
    onStop: async (id) => { await session.stop(_app, id); },
  }).catch(e => logError("conductor", `rollback watcher error: ${e}`));

  return Response.json({ status: "watching" });
}

// ── Server ──────────────────────────────────────────────────────────────────

export function startConductor(app: AppContext, port = DEFAULT_PORT, opts?: {
  quiet?: boolean;
  issueLabel?: string;
  issueAutoDispatch?: boolean;
}): { stop(): void } {
  _app = app;
  const server = Bun.serve({
    port,
    hostname: DEFAULT_CONDUCTOR_HOST,
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

        if (req.method === "POST" && path === "/hooks/github/merge") {
          return handlePRMergeWebhook(req);
        }

        // ── Worker management (hosted control plane) ──────────────────
        if (req.method === "POST" && path === "/api/workers/register") {
          return handleWorkerRegister(req);
        }
        if (req.method === "POST" && path === "/api/workers/heartbeat") {
          return handleWorkerHeartbeat(req);
        }
        if (req.method === "POST" && path === "/api/workers/deregister") {
          return handleWorkerDeregister(req);
        }
        if (req.method === "GET" && path === "/api/workers") {
          return handleWorkerList(req);
        }

        // ── Tenant policy management (hosted control plane) ────────────
        if (path.startsWith("/api/tenant/polic")) {
          if (req.method === "GET" && path === "/api/tenant/policies") {
            return handleTenantPolicyList();
          }
          if (path.startsWith("/api/tenant/policy/")) {
            const tenantId = extractPathSegment(path, 4);
            if (!tenantId) return Response.json({ error: "missing tenant id" }, { status: 400 });
            if (req.method === "GET") return handleTenantPolicyGet(tenantId);
            if (req.method === "PUT") return handleTenantPolicySet(req, tenantId);
            if (req.method === "DELETE") return handleTenantPolicyDelete(tenantId);
          }
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

  if (!opts?.quiet) logInfo("conductor", `Ark conductor listening on localhost:${port}`);

  // Schedule poller — check every 60 seconds
  const scheduleTimer = setInterval(() => safeAsync("schedule polling", async () => {
    const schedules = listSchedules(app).filter(s => s.enabled);
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
      await safeAsync(`scheduled dispatch for ${sched.id}`, async () => {
        const s = session.startSession(_app, {
          summary: sched.summary ?? `Scheduled: ${sched.id}`,
          repo: sched.repo ?? undefined,
          workdir: sched.workdir ?? undefined,
          flow: sched.flow,
          compute_name: sched.compute_name ?? undefined,
          group_name: sched.group_name ?? undefined,
        });
        await session.dispatch(_app, s.id);
        updateScheduleLastRun(app, sched.id);
        _app.events.log(s.id, "scheduled_dispatch", {
          actor: "scheduler",
          data: { schedule_id: sched.id, cron: sched.cron },
        });
      });
    }
  }), POLL_INTERVAL_MS);

  // PR review poller - check every 60 seconds
  const prTimer = setInterval(() =>
    safeAsync("PR review polling", () => pollPRReviews(app)),
  POLL_INTERVAL_MS);

  // Issue poller - only start if a label is configured
  let issueTimer: ReturnType<typeof setInterval> | null = null;
  if (opts?.issueLabel) {
    const issueOpts = { label: opts.issueLabel, autoDispatch: opts.issueAutoDispatch };
    // Run immediately on start
    safeAsync("issue polling: initial", () => pollIssues(app,issueOpts));
    issueTimer = setInterval(() =>
      safeAsync("issue polling", () => pollIssues(app,issueOpts)),
    POLL_INTERVAL_MS);
  }

  return {
    stop() {
      clearInterval(scheduleTimer);
      clearInterval(prTimer);
      if (issueTimer) clearInterval(issueTimer);
      server.stop();
    },
  };
}

/**
 * Deliver a message to a session's channel, using arkd if available.
 * Falls back to direct HTTP to the channel port for local sessions.
 *
 * Uses the module-level `_app` for compute lookup. In multi-tenant mode,
 * compute records are tenant-scoped and the caller is responsible for
 * passing sessions from a correctly scoped AppContext; compute lookup here
 * intentionally uses the root `_app` since compute names are typically
 * scoped identically.
 */
export async function deliverToChannel(
  targetSession: Session,
  channelPort: number,
  payload: Record<string, unknown>,
): Promise<void> {
  // Try arkd delivery first (works for both local and remote)
  const computeName = targetSession.compute_name || "local";
  const tenantApp = targetSession.tenant_id ? _app.forTenant(targetSession.tenant_id) : _app;
  const compute = tenantApp.computes.get(computeName);
  const provider = compute ? getProvider(compute.provider) : null;
  if (provider?.getArkdUrl) {
    try {
      const arkdUrl = provider.getArkdUrl(compute!);
      const client = new ArkdClient(arkdUrl);
      const result = await client.channelDeliver({ channelPort, payload });
      if (result.delivered) return;
    } catch { /* arkd not available — fall through to direct HTTP */ }
  }

  // Fallback: direct HTTP to channel port (local only)
  try {
    await fetch(`${DEFAULT_CHANNEL_BASE_URL}:${channelPort}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch { /* channel not reachable — expected when agent hasn't started channel yet */ }
}

// ── Worker management handlers ──────────────────────────────────────────────

async function handleWorkerRegister(req: Request): Promise<Response> {
  try {
    const registry = _app.workerRegistry;
    const body = await req.json() as {
      id: string;
      url: string;
      capacity?: number;
      compute_name?: string;
      tenant_id?: string;
      metadata?: Record<string, unknown>;
    };
    if (!body.id || !body.url) {
      return Response.json({ error: "id and url are required" }, { status: 400 });
    }
    registry.register({
      id: body.id,
      url: body.url,
      capacity: body.capacity ?? 5,
      compute_name: body.compute_name ?? null,
      tenant_id: body.tenant_id ?? null,
      metadata: body.metadata ?? {},
    });
    logInfo("conductor", `Worker registered: ${body.id} (${body.url})`);
    return Response.json({ status: "registered", id: body.id });
  } catch (e: any) {
    if (e.message?.includes("hosted mode only")) {
      return Response.json({ error: "Worker registry not available (not running in hosted mode)" }, { status: 503 });
    }
    throw e;
  }
}

async function handleWorkerHeartbeat(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { id: string };
    if (!body.id) {
      return Response.json({ error: "id is required" }, { status: 400 });
    }
    _app.workerRegistry.heartbeat(body.id);
    return Response.json({ status: "ok" });
  } catch (e: any) {
    if (e.message?.includes("hosted mode only")) {
      return Response.json({ error: "Worker registry not available" }, { status: 503 });
    }
    throw e;
  }
}

async function handleWorkerDeregister(req: Request): Promise<Response> {
  try {
    const body = await req.json() as { id: string };
    if (!body.id) {
      return Response.json({ error: "id is required" }, { status: 400 });
    }
    _app.workerRegistry.deregister(body.id);
    logInfo("conductor", `Worker deregistered: ${body.id}`);
    return Response.json({ status: "deregistered" });
  } catch (e: any) {
    if (e.message?.includes("hosted mode only")) {
      return Response.json({ error: "Worker registry not available" }, { status: 503 });
    }
    throw e;
  }
}

function handleWorkerList(_req: Request): Response {
  try {
    const workers = _app.workerRegistry.list();
    return Response.json(workers);
  } catch (e: any) {
    if (e.message?.includes("hosted mode only")) {
      return Response.json({ error: "Worker registry not available" }, { status: 503 });
    }
    throw e;
  }
}

// ── Tenant policy handlers ─────────────────────────────────────────────────

function handleTenantPolicyGet(tenantId: string): Response {
  try {
    const pm = _app.tenantPolicyManager;
    if (!pm) return Response.json({ error: "Tenant policy manager not available (not running in hosted mode)" }, { status: 503 });
    const policy = pm.getPolicy(tenantId);
    if (!policy) return Response.json({ error: "policy not found" }, { status: 404 });
    return Response.json(policy);
  } catch (e: any) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

async function handleTenantPolicySet(req: Request, tenantId: string): Promise<Response> {
  try {
    const pm = _app.tenantPolicyManager;
    if (!pm) return Response.json({ error: "Tenant policy manager not available (not running in hosted mode)" }, { status: 503 });
    const body = await req.json() as Record<string, unknown>;
    pm.setPolicy({
      tenant_id: tenantId,
      allowed_providers: (body.allowed_providers as string[]) ?? [],
      default_provider: (body.default_provider as string) ?? "k8s",
      max_concurrent_sessions: (body.max_concurrent_sessions as number) ?? 10,
      max_cost_per_day_usd: (body.max_cost_per_day_usd as number | null) ?? null,
      compute_pools: (body.compute_pools as Array<{ pool_id: string; weight?: number }>) ?? [],
    });
    logInfo("conductor", `Tenant policy set for: ${tenantId}`);
    return Response.json({ status: "ok", tenant_id: tenantId });
  } catch (e: any) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

function handleTenantPolicyDelete(tenantId: string): Response {
  try {
    const pm = _app.tenantPolicyManager;
    if (!pm) return Response.json({ error: "Tenant policy manager not available (not running in hosted mode)" }, { status: 503 });
    const deleted = pm.deletePolicy(tenantId);
    if (!deleted) return Response.json({ error: "policy not found" }, { status: 404 });
    logInfo("conductor", `Tenant policy deleted for: ${tenantId}`);
    return Response.json({ status: "deleted", tenant_id: tenantId });
  } catch (e: any) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

function handleTenantPolicyList(): Response {
  try {
    const pm = _app.tenantPolicyManager;
    if (!pm) return Response.json({ error: "Tenant policy manager not available (not running in hosted mode)" }, { status: 503 });
    return Response.json(pm.listPolicies());
  } catch (e: any) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

// ── Report handling ─────────────────────────────────────────────────────────

async function handleReport(app: AppContext, sessionId: string, report: OutboundMessage): Promise<void> {
  // Delegate business logic to session.ts
  const result = session.applyReport(app, sessionId, report);

  // Log events
  for (const evt of result.logEvents ?? []) {
    app.events.log(sessionId, evt.type, evt.opts);
  }

  // Store message for TUI chat view
  if (result.message) {
    app.messages.send(sessionId, result.message.role, result.message.content, result.message.type);
  }

  // Emit bus events
  for (const evt of result.busEvents ?? []) {
    eventBus.emit(evt.type, evt.sessionId, evt.data);
  }

  // Apply store updates
  if (Object.keys(result.updates).length > 0) {
    app.sessions.update(sessionId, result.updates);
  }

  // Handle advance + auto-dispatch for completed reports via orchestrator-mediated handoff
  if (result.shouldAdvance) {
    const handoff = await session.mediateStageHandoff(app, sessionId, {
      autoDispatch: result.shouldAutoDispatch,
      source: "channel_report",
    });
    if (handoff.blockedByVerification) {
      const s = app.sessions.get(sessionId);
      sendOSNotification("Ark: Verification failed", `${s?.summary ?? sessionId} - ${handoff.message.slice(0, 100)}`);
      return;
    }
  }

  // On-failure retry loop: if the stage has on_failure: "retry(N)", attempt retry + re-dispatch
  if (result.shouldRetry) {
    const retryResult = session.retryWithContext(app, sessionId, {
      maxRetries: result.retryMaxRetries,
    });
    if (retryResult.ok) {
      logInfo("conductor", `on_failure retry triggered for ${sessionId}: ${retryResult.message}`);
      session.dispatch(app, sessionId).catch(err => {
        logError("conductor", `on_failure retry dispatch failed for ${sessionId}: ${err?.message ?? err}`);
      });
      return; // Retry in progress -- skip failure notification
    }
    // Max retries exhausted -- fall through to normal failure handling
    logWarn("conductor", `on_failure retry exhausted for ${sessionId}: ${retryResult.message}`);
  }

  // OS notification on stage completion or failure
  const finalSession = app.sessions.get(sessionId);
  if (finalSession && (report.type === "completed" || report.type === "error")) {
    const notifyTitle = report.type === "completed" ? "Stage completed" : "Session failed";
    const notifyBody = `${finalSession.summary ?? sessionId} - ${finalSession.stage ?? ""}`;
    sendOSNotification(`Ark: ${notifyTitle}`, notifyBody);
  }

  // PR URL detection (agent-provided)
  if (result.prUrl) {
    app.sessions.update(sessionId, { pr_url: result.prUrl });
    app.events.log(sessionId, "pr_detected", {
      actor: "agent",
      data: { pr_url: result.prUrl },
    });
  }

  // Persist structured artifacts for queryable tracking
  try {
    const r = report as unknown as Record<string, unknown>;
    if (result.prUrl) {
      app.artifacts.add(sessionId, "pr", [result.prUrl]);
    }
    if (Array.isArray(r.filesChanged) && r.filesChanged.length > 0) {
      app.artifacts.add(sessionId, "file", r.filesChanged as string[]);
    }
    if (Array.isArray(r.commits) && r.commits.length > 0) {
      app.artifacts.add(sessionId, "commit", r.commits as string[]);
    }
    const s = app.sessions.get(sessionId);
    if (s?.branch && report.type === "completed") {
      app.artifacts.add(sessionId, "branch", [s.branch]);
    }
  } catch { /* best-effort artifact tracking */ }

  // Index session completion in knowledge graph (best-effort)
  if (report.type === "completed" && app.knowledge) {
    try {
      const { indexSessionCompletion } = await import("../knowledge/indexer.js");
      const s = app.sessions.get(sessionId);
      const changedFiles = ((report as Record<string, unknown>).filesChanged as string[] | undefined) ?? [];
      indexSessionCompletion(
        app.knowledge,
        sessionId,
        s?.summary ?? "",
        "completed",
        changedFiles,
      );
    } catch { /* best-effort knowledge indexing */ }
  }

  // Auto-create PR on completion (when session has a git remote and no PR yet)
  if (report.type === "completed" && !result.prUrl) {
    const s = app.sessions.get(sessionId);
    if (s && !s.pr_url && s.config?.github_url && s.branch) {
      // Check repo config for auto_pr override (defaults to true)
      const { loadRepoConfig } = await import("../repo-config.js");
      const repoConfig = s.workdir ? loadRepoConfig(s.workdir) : {};
      const autoPR = repoConfig.auto_pr !== false;

      if (autoPR) {
        safeAsync(`auto-pr: ${sessionId}`, async () => {
          const prResult = await session.createWorktreePR(app, sessionId, {
            title: s.summary ?? undefined,
          });
          if (prResult.ok && prResult.pr_url) {
            logInfo("conductor", `auto-PR created for ${sessionId}: ${prResult.pr_url}`);
          }
        });
      }
    }
  }
}

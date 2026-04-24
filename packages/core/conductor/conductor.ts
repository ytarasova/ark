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
 */

// Bun global type declaration (avoids requiring @types/bun as a dependency)
declare const Bun: {
  serve(options: { port: number; hostname: string; fetch(req: Request): Promise<Response> | Response }): {
    stop(closeActiveConnections?: boolean): void;
  };
};

import type { Session } from "../../types/index.js";
import type { AppContext } from "../app.js";
import { createWorktreePR } from "../services/worktree/index.js";
import { eventBus } from "../hooks.js";
import type { OutboundMessage } from "./channel-types.js";
import { getProvider } from "../../compute/index.js";
import { providerOf } from "../../compute/adapters/provider-map.js";
import { indexSession } from "../search/search.js";
import { listSchedules, cronMatches, updateScheduleLastRun } from "../schedule.js";
import { pollPRReviews } from "../integrations/pr-poller.js";
import { pollPRMerges } from "../integrations/pr-merge-poller.js";
import { pollIssues } from "../integrations/issue-poller.js";
import { ArkdClient } from "../../arkd/client.js";
import { safeAsync } from "../safe.js";
import { logDebug, logError, logInfo, logWarn } from "../observability/structured-log.js";
import { sendOSNotification } from "../notify.js";
import { watchMergedPR, type RollbackConfig } from "../integrations/rollback.js";
import { emitStageSpanEnd, emitSessionSpanEnd, flushSpans } from "../observability/otlp.js";
import { DEFAULT_CONDUCTOR_PORT, DEFAULT_CONDUCTOR_HOST, DEFAULT_CHANNEL_BASE_URL } from "../constants.js";
import { readForensicFile } from "../services/session-forensic.js";

const DEFAULT_PORT = DEFAULT_CONDUCTOR_PORT;

/** Interval between schedule and PR review poll ticks */
const POLL_INTERVAL_MS = 60_000;

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
 * Conductor -- all routes, pollers, and handlers as instance methods.
 *
 * The conductor used to keep its own module-level `_app` so that free
 * helpers like `deliverToChannel` could reach the AppContext. That is
 * gone: the conductor is now a class with an injected `AppContext`, and
 * `deliverToChannel` is a free function that takes `app` explicitly.
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

    // Schedule poller -- check every 60 seconds
    this.timers.push(
      setInterval(
        () =>
          safeAsync("schedule polling", async () => {
            const schedules = (await listSchedules(this.app)).filter((s) => s.enabled);
            const now = new Date();
            for (const sched of schedules) {
              if (!cronMatches(sched.cron, now)) continue;
              if (sched.last_run) {
                const lastRun = new Date(sched.last_run);
                if (
                  lastRun.getMinutes() === now.getMinutes() &&
                  lastRun.getHours() === now.getHours() &&
                  lastRun.getDate() === now.getDate()
                )
                  continue;
              }
              await safeAsync(`scheduled dispatch for ${sched.id}`, async () => {
                const s = await this.app.sessionLifecycle.start({
                  summary: sched.summary ?? `Scheduled: ${sched.id}`,
                  repo: sched.repo ?? undefined,
                  workdir: sched.workdir ?? undefined,
                  flow: sched.flow,
                  compute_name: sched.compute_name ?? undefined,
                  group_name: sched.group_name ?? undefined,
                });
                await this.app.dispatchService.dispatch(s.id);
                await updateScheduleLastRun(this.app, sched.id);
                await this.app.events.log(s.id, "scheduled_dispatch", {
                  actor: "scheduler",
                  data: { schedule_id: sched.id, cron: sched.cron },
                });
              });
            }
          }),
        POLL_INTERVAL_MS,
      ),
    );

    // PR review poller - check every 60 seconds
    this.timers.push(
      setInterval(() => safeAsync("PR review polling", () => pollPRReviews(this.app)), POLL_INTERVAL_MS),
    );

    // PR merge poller - check every 30 seconds (blocks flow completion, needs faster checks)
    const MERGE_POLL_INTERVAL_MS = 30_000;
    this.timers.push(
      setInterval(() => safeAsync("PR merge polling", () => pollPRMerges(this.app)), MERGE_POLL_INTERVAL_MS),
    );

    // Issue poller - only start if a label is configured
    if (this.opts.issueLabel) {
      const issueOpts = { label: this.opts.issueLabel, autoDispatch: this.opts.issueAutoDispatch };
      safeAsync("issue polling: initial", () => pollIssues(this.app, issueOpts));
      this.timers.push(
        setInterval(() => safeAsync("issue polling", () => pollIssues(this.app, issueOpts)), POLL_INTERVAL_MS),
      );
    }

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
        return this.handleHookStatus(req, url);
      }

      if (req.method === "POST" && path === "/hooks/github/merge") {
        return this.handlePRMergeWebhook(req);
      }

      // ── Worker management (hosted control plane) ──────────────────
      if (req.method === "POST" && path === "/api/workers/register") {
        return this.handleWorkerRegister(req);
      }
      if (req.method === "POST" && path === "/api/workers/heartbeat") {
        return this.handleWorkerHeartbeat(req);
      }
      if (req.method === "POST" && path === "/api/workers/deregister") {
        return this.handleWorkerDeregister(req);
      }
      if (req.method === "GET" && path === "/api/workers") {
        return this.handleWorkerList();
      }

      // ── Tenant policy management (hosted control plane) ────────────
      if (path.startsWith("/api/tenant/polic")) {
        if (req.method === "GET" && path === "/api/tenant/policies") {
          return this.handleTenantPolicyList();
        }
        if (path.startsWith("/api/tenant/policy/")) {
          const tenantId = extractPathSegment(path, 4);
          if (!tenantId) return Response.json({ error: "missing tenant id" }, { status: 400 });
          if (req.method === "GET") return this.handleTenantPolicyGet(tenantId);
          if (req.method === "PUT") return this.handleTenantPolicySet(req, tenantId);
          if (req.method === "DELETE") return this.handleTenantPolicyDelete(tenantId);
        }
      }

      // ── LLM proxy: forward to router ──────────────────────────
      if (req.method === "POST" && path === "/v1/chat/completions") {
        return this.proxyToRouter(req, "/v1/chat/completions");
      }
      if (req.method === "GET" && path === "/v1/models") {
        return this.proxyToRouter(req, "/v1/models");
      }

      if (req.method === "GET") {
        return this.handleRestApi(req, path);
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }

  // ── Tenant resolution ────────────────────────────────────────────────────

  /**
   * Resolve the tenant id for an inbound HTTP request by delegating to the
   * mode-specific resolver composed at DI startup. Local and hosted modes
   * have different trust rules (see `app-mode.ts` + the two implementations);
   * this method stays a thin adapter from `Request` headers to the resolver
   * input shape.
   */
  private resolveTenant(req: Request) {
    const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization");
    const tenantHeader = req.headers.get("x-ark-tenant-id") ?? req.headers.get("X-Ark-Tenant-Id");
    return this.app.mode.tenantResolver.resolve({
      authHeader,
      tenantHeader,
      validateToken: (token) => this.app.apiKeys.validate(token),
    });
  }

  private async appForRequest(
    req: Request,
  ): Promise<{ ok: true; app: AppContext } | { ok: false; response: Response }> {
    const r = await this.resolveTenant(req);
    if (r.ok === false) {
      return { ok: false, response: Response.json({ error: r.error }, { status: r.status }) };
    }
    return { ok: true, app: this.app.forTenant(r.tenantId) };
  }

  // ── Route handlers ───────────────────────────────────────────────────────

  private async handleChannelReport(req: Request, sessionId: string): Promise<Response> {
    const resolved = await this.appForRequest(req);
    if (resolved.ok === false) return resolved.response;
    const report = (await req.json()) as OutboundMessage;
    await handleReport(resolved.app, sessionId, report);
    return Response.json({ status: "ok" });
  }

  private async handleAgentRelay(req: Request): Promise<Response> {
    const resolved = await this.appForRequest(req);
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

  private async handleHookStatus(req: Request, url: URL): Promise<Response> {
    const sessionId = url.searchParams.get("session");
    if (!sessionId) return Response.json({ error: "missing session param" }, { status: 400 });

    const resolved = await this.appForRequest(req);
    if (resolved.ok === false) return resolved.response;
    const app = resolved.app;
    const s = await app.sessions.get(sessionId);
    if (!s) return Response.json({ error: "session not found" }, { status: 404 });

    const payload = (await req.json()) as Record<string, unknown>;
    const event = String(payload.hook_event_name ?? "");

    // Channel-report passthrough: the agent-sdk `ask_user` MCP (and any future
    // non-hook emitters) POST `{type: "question"|"progress"|"error"}` payloads
    // here without a `hook_event_name`. Route them through the same report
    // pipeline the claude runtime's conductor-channel uses so the UI sees one
    // event shape regardless of source.
    if (!payload.hook_event_name && typeof payload.type === "string") {
      const reportType = payload.type as string;
      if (reportType === "question" || reportType === "progress" || reportType === "error") {
        const msgText = (payload.message ?? payload.question ?? payload.error ?? "") as string;
        const report = {
          type: reportType,
          sessionId,
          stage: (payload.stage as string) ?? "",
          ...(reportType === "question" ? { question: msgText } : {}),
          ...(reportType === "error" ? { error: msgText } : {}),
          ...(reportType === "progress" ? { message: msgText } : {}),
          ...(payload.context != null ? { context: payload.context } : {}),
          ...(payload.source ? { source: payload.source } : {}),
        } as unknown as OutboundMessage;
        await handleReport(app, sessionId, report);
        return Response.json({ status: "ok", mapped: reportType });
      }
    }

    // Guard: ignore stale hook events from a previous stage's agent session.
    const hookAgentId = payload.session_id as string | undefined;
    if (hookAgentId && s.claude_session_id && hookAgentId !== s.claude_session_id) {
      return Response.json({ status: "ok", mapped: "ignored_stale" });
    }

    // Guardrail evaluation for PreToolUse events
    if (event === "PreToolUse") {
      const toolName = String(payload.tool_name ?? "");
      const toolInput = (payload.tool_input ?? {}) as Record<string, any>;
      const { evaluateToolCall } = await import("../session/guardrails.js");
      const evalResult = evaluateToolCall(toolName, toolInput);

      if (evalResult.action === "block") {
        await app.events.log(sessionId, "guardrail_blocked", {
          actor: "system",
          data: { tool: toolName, pattern: evalResult.rule?.pattern, input: toolInput },
        });
      } else if (evalResult.action === "warn") {
        await app.events.log(sessionId, "guardrail_warning", {
          actor: "system",
          data: { tool: toolName, pattern: evalResult.rule?.pattern },
        });
      }

      return Response.json({ status: "ok", guardrail: evalResult.action });
    }

    // Delegate business logic to session.ts
    const result = await app.sessionHooks.applyHookStatus(s, event, payload);

    // Apply events
    for (const evt of result.events ?? []) {
      await app.events.log(sessionId, evt.type, evt.opts);
    }

    // Apply store updates
    if (result.updates) {
      await app.sessions.update(sessionId, result.updates);
    }

    // Mark messages read on terminal states
    if (result.markRead) {
      await app.messages.markRead(sessionId);
    }

    // On-failure retry loop
    if (result.shouldRetry && result.newStatus === "failed") {
      const retryResult = await app.sessionHooks.retryWithContext(sessionId, {
        maxRetries: result.retryMaxRetries,
      });
      if (retryResult.ok) {
        logInfo("conductor", `on_failure retry (hook) triggered for ${sessionId}: ${retryResult.message}`);
        eventBus.emit("hook_status", sessionId, {
          data: { event, status: "ready", retry: true, ...payload } as Record<string, unknown>,
        });
        app.dispatchService.dispatch(sessionId).catch((err) => {
          logError("conductor", `on_failure retry dispatch (hook) failed for ${sessionId}: ${err?.message ?? err}`);
        });
        return Response.json({ status: "ok", mapped: "retry" });
      }
      logWarn("conductor", `on_failure retry (hook) exhausted for ${sessionId}: ${retryResult.message}`);
    }

    // Emit to event bus
    if (result.newStatus) {
      eventBus.emit("hook_status", sessionId, {
        data: { event, status: result.newStatus, ...payload } as Record<string, unknown>,
      });

      if (result.newStatus === "completed" || result.newStatus === "failed") {
        await app.sessionLifecycle.cleanupOnTerminal(sessionId);

        // Worktree removal + session_cleaned event (idempotent; safe to call
        // here without transactional coupling -- cleanup is external state only).
        try {
          const { cleanupSession } = await import("../services/session/cleanup.js");
          const sessionForCleanup = await app.sessions.get(sessionId);
          if (sessionForCleanup) await cleanupSession(app, sessionForCleanup);
        } catch (err: any) {
          logDebug("conductor", `session cleanup non-fatal: ${err?.message ?? err}`);
        }

        emitStageSpanEnd(sessionId, { status: result.newStatus });
        emitSessionSpanEnd(sessionId, { status: result.newStatus });
        flushSpans();

        try {
          const { evaluateSession } = await import("../knowledge/evals.js");
          const freshSession = await app.sessions.get(sessionId);
          if (freshSession) await evaluateSession(app, freshSession);
        } catch {
          logDebug("conductor", "skip eval on error");
        }
      }
    }

    if (result.shouldAdvance) {
      await app.sessionHooks.mediateStageHandoff(sessionId, {
        autoDispatch: result.shouldAutoDispatch,
        source: "hook_status",
      });
    }

    if (result.shouldIndex && result.indexTranscript) {
      await safeAsync("transcript indexing", async () => {
        await indexSession(app, result.indexTranscript!.transcriptPath, result.indexTranscript!.sessionId);
      });
    }

    if (result.newStatus) {
      try {
        await app.ledger.addEntry("default", "progress", `Session ${sessionId} status: ${result.newStatus}`, sessionId);
      } catch {
        logDebug("conductor", "skip ledger on error");
      }
    }

    return Response.json({ status: "ok", mapped: result.newStatus ?? "no-op" });
  }

  private async handleRestApi(req: Request, path: string): Promise<Response> {
    if (path === "/health") {
      return Response.json({
        status: "ok",
        arkDir: this.app.config.dirs.ark,
      });
    }

    const resolved = await this.appForRequest(req);
    if (resolved.ok === false) return resolved.response;
    const app = resolved.app;

    if (path === "/api/sessions") {
      const url = new URL(req.url);
      // `?roots=true` activates the tree-aware list path (rootsOnly + child_stats).
      // Preserves the flat default for existing callers that don't pass the flag.
      if (url.searchParams.get("roots") === "true") {
        return Response.json(await app.sessions.listRoots());
      }
      return Response.json(await app.sessions.list());
    }
    if (path.startsWith("/api/sessions/")) {
      const id = extractPathSegment(path, 3);
      if (!id) return Response.json({ error: "missing session id" }, { status: 400 });
      const sub = extractPathSegment(path, 4);
      // ── /api/sessions/:id/tree/stream -- SSE debounced tree deltas ──
      if (sub === "tree" && extractPathSegment(path, 5) === "stream") {
        return this.handleTreeStream(app, id);
      }
      // ── /api/sessions/:id/tree -- recursive tree snapshot ───────────
      if (sub === "tree") {
        const existing = await app.sessions.get(id);
        if (!existing) return Response.json({ error: "not found" }, { status: 404 });
        try {
          const root = await app.sessions.loadTree(id);
          return Response.json({ root });
        } catch (e: any) {
          return Response.json({ error: String(e?.message ?? e) }, { status: 400 });
        }
      }
      // ── /api/sessions/:id/children -- direct children with stats ────
      if (sub === "children") {
        const existing = await app.sessions.get(id);
        if (!existing) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({ sessions: await app.sessions.listChildren(id) });
      }
      // ── /api/sessions/:id/stdio | /transcript -- forensic files ─────
      // The session must exist (404 otherwise); the file may not yet
      // (200 with an empty body). Respects a 2MB cap with ?tail=<N> for
      // long-running sessions.
      if (sub === "stdio" || sub === "transcript") {
        const s = await app.sessions.get(id);
        if (!s) return Response.json({ error: "not found" }, { status: 404 });
        const innerUrl = new URL(req.url);
        const rawTail = innerUrl.searchParams.get("tail");
        const tail = rawTail != null ? Number(rawTail) : undefined;
        if (rawTail != null && (!Number.isFinite(tail) || (tail as number) <= 0)) {
          return Response.json({ error: "tail must be a positive integer" }, { status: 400 });
        }
        const fileName = sub === "stdio" ? "stdio.log" : "transcript.jsonl";
        const read = await readForensicFile(app.config.tracksDir, id, fileName, { tail });
        if (read.tooLarge) {
          return Response.json(
            { error: `file is ${read.size} bytes, over the 2MB cap -- use ?tail=<N> to read the tail` },
            { status: 413 },
          );
        }
        const contentType = sub === "stdio" ? "text/plain; charset=utf-8" : "application/x-ndjson; charset=utf-8";
        return new Response(read.content, { status: 200, headers: { "Content-Type": contentType } });
      }
      if (sub) return Response.json({ error: "not found" }, { status: 404 });
      const s = await app.sessions.get(id);
      return s ? Response.json(s) : Response.json({ error: "not found" }, { status: 404 });
    }
    if (path.startsWith("/api/events/")) {
      const id = extractPathSegment(path, 3);
      if (!id) return Response.json({ error: "missing session id" }, { status: 400 });
      if (!(await app.sessions.get(id))) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json(await app.events.list(id));
    }
    return new Response("Not found", { status: 404 });
  }

  /**
   * SSE stream that emits an initial `tree-update` snapshot on connect, then
   * debounced `tree-update` deltas whenever any descendant's status changes
   * (via the `hook_status` event) or a new descendant session is created.
   *
   * Scoped to the tenant-resolved `app` so cross-tenant fan-out cannot leak
   * across streams. Unsubscribes from the bus when the client disconnects.
   */
  private handleTreeStream(app: AppContext, rootId: string): Response {
    const DEBOUNCE_MS = 200;
    const encoder = new TextEncoder();
    let unsub: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            // Controller closed mid-send.
          }
        };

        // Collect descendant ids so we can filter bus events to this tree.
        let descendantIds = new Set<string>();
        const rebuild = async (): Promise<unknown | null> => {
          try {
            const root = await app.sessions.loadTree(rootId);
            const next = new Set<string>();
            const walk = (n: { id: string; children: any[] }) => {
              next.add(n.id);
              for (const c of n.children) walk(c);
            };
            walk(root as any);
            descendantIds = next;
            return root;
          } catch (err: any) {
            send("error", { message: String(err?.message ?? err) });
            return null;
          }
        };

        const pushSnapshot = async () => {
          const root = await rebuild();
          if (root) send("tree-update", { root });
        };

        // Initial snapshot.
        await pushSnapshot();

        const scheduleSnapshot = () => {
          if (debounceTimer) return;
          debounceTimer = setTimeout(async () => {
            debounceTimer = null;
            await pushSnapshot();
          }, DEBOUNCE_MS);
        };

        unsub = eventBus.onAll((evt) => {
          // Listen for status + cost-relevant events. `session_created` is
          // always eligible (a new child may need to join the tree); other
          // events are gated on tree membership.
          if (evt.type !== "hook_status" && evt.type !== "session_updated" && evt.type !== "session_created") return;
          if (evt.type !== "session_created" && !descendantIds.has(evt.sessionId)) return;
          scheduleSnapshot();
        });
      },
      cancel() {
        closed = true;
        if (debounceTimer) clearTimeout(debounceTimer);
        unsub?.();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  private async handlePRMergeWebhook(req: Request): Promise<Response> {
    const payload = (await req.json()) as GitHubPRWebhookPayload;
    if (payload.action !== "closed" || !payload.pull_request?.merged) {
      return Response.json({ status: "ignored" });
    }

    const pr = payload.pull_request;
    const repo = payload.repository;

    if (!repo?.owner?.login || !repo?.name || !pr?.head?.ref || !pr?.base?.ref || !pr?.merge_commit_sha) {
      return Response.json({ status: "incomplete_payload" }, { status: 400 });
    }

    const sessions = await this.app.sessions.list();
    const matchedSession = sessions.find((s) => {
      return s.config?.github_url === pr.html_url || s.branch === pr.head?.ref;
    });

    if (!matchedSession) return Response.json({ status: "no_session" });

    const config: RollbackConfig = this.app.rollbackConfig ?? {
      enabled: false,
      timeout: 600,
      on_timeout: "ignore",
      auto_merge: false,
      health_url: null,
    };

    if (!config.enabled) return Response.json({ status: "rollback_disabled" });

    const ghToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    const fetcher = async (sha: string) => {
      const res = await fetch(`https://api.github.com/repos/${repo.full_name}/commits/${sha}/check-suites`, {
        headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
      });
      return res.json() as Promise<{ check_suites: import("../integrations/rollback.js").CheckSuiteResult[] }>;
    };

    const healthFetcher = config.health_url
      ? async () => {
          try {
            const res = await fetch(config.health_url!);
            return res.ok;
          } catch {
            return false;
          }
        }
      : undefined;

    const onRevert = async (revertPayload: import("../integrations/rollback.js").RevertPayload) => {
      await fetch(`https://api.github.com/repos/${repo?.full_name}/pulls`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(revertPayload),
      });
    };

    watchMergedPR(this.app, {
      sessionId: matchedSession.id,
      sha: pr.merge_commit_sha,
      owner: repo.owner.login,
      repo: repo.name,
      prNumber: pr.number,
      prTitle: pr.title,
      branch: pr.head.ref,
      baseBranch: pr.base.ref,
      config,
      fetcher,
      healthFetcher,
      onRevert,
      onStop: async (id) => {
        await this.app.sessionLifecycle.stop(id);
      },
    }).catch((e) => logError("conductor", `rollback watcher error: ${e}`));

    return Response.json({ status: "watching" });
  }

  // ── Worker management handlers ───────────────────────────────────────────

  private async handleWorkerRegister(req: Request): Promise<Response> {
    try {
      const registry = this.app.workerRegistry;
      const body = (await req.json()) as {
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

  private async handleWorkerHeartbeat(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as { id: string };
      if (!body.id) {
        return Response.json({ error: "id is required" }, { status: 400 });
      }
      this.app.workerRegistry.heartbeat(body.id);
      return Response.json({ status: "ok" });
    } catch (e: any) {
      if (e.message?.includes("hosted mode only")) {
        return Response.json({ error: "Worker registry not available" }, { status: 503 });
      }
      throw e;
    }
  }

  private async handleWorkerDeregister(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as { id: string };
      if (!body.id) {
        return Response.json({ error: "id is required" }, { status: 400 });
      }
      this.app.workerRegistry.deregister(body.id);
      logInfo("conductor", `Worker deregistered: ${body.id}`);
      return Response.json({ status: "deregistered" });
    } catch (e: any) {
      if (e.message?.includes("hosted mode only")) {
        return Response.json({ error: "Worker registry not available" }, { status: 503 });
      }
      throw e;
    }
  }

  private handleWorkerList(): Response {
    try {
      const workers = this.app.workerRegistry.list();
      return Response.json(workers);
    } catch (e: any) {
      if (e.message?.includes("hosted mode only")) {
        return Response.json({ error: "Worker registry not available" }, { status: 503 });
      }
      throw e;
    }
  }

  // ── Tenant policy handlers ───────────────────────────────────────────────

  private handleTenantPolicyGet(tenantId: string): Response {
    try {
      const pm = this.app.tenantPolicyManager;
      if (!pm)
        return Response.json(
          { error: "Tenant policy manager not available (not running in hosted mode)" },
          { status: 503 },
        );
      const policy = pm.getPolicy(tenantId);
      if (!policy) return Response.json({ error: "policy not found" }, { status: 404 });
      return Response.json(policy);
    } catch (e: any) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }

  private async handleTenantPolicySet(req: Request, tenantId: string): Promise<Response> {
    try {
      const pm = this.app.tenantPolicyManager;
      if (!pm)
        return Response.json(
          { error: "Tenant policy manager not available (not running in hosted mode)" },
          { status: 503 },
        );
      const body = (await req.json()) as Record<string, unknown>;
      pm.setPolicy({
        tenant_id: tenantId,
        allowed_providers: (body.allowed_providers as string[]) ?? [],
        default_provider: (body.default_provider as string) ?? "k8s",
        max_concurrent_sessions: (body.max_concurrent_sessions as number) ?? 10,
        max_cost_per_day_usd: (body.max_cost_per_day_usd as number | null) ?? null,
        compute_pools: (body.compute_pools as unknown as import("../auth/tenant-policy.js").ComputePoolRef[]) ?? [],
        router_enabled: (body.router_enabled as boolean | null) ?? null,
        router_required: (body.router_required as boolean) ?? false,
        router_policy: (body.router_policy as string | null) ?? null,
        auto_index: (body.auto_index as boolean | null) ?? null,
        auto_index_required: (body.auto_index_required as boolean) ?? false,
        tensorzero_enabled: (body.tensorzero_enabled as boolean | null) ?? null,
        allowed_k8s_contexts: (body.allowed_k8s_contexts as string[]) ?? [],
      });
      logInfo("conductor", `Tenant policy set for: ${tenantId}`);
      return Response.json({ status: "ok", tenant_id: tenantId });
    } catch (e: any) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }

  private handleTenantPolicyDelete(tenantId: string): Response {
    try {
      const pm = this.app.tenantPolicyManager;
      if (!pm)
        return Response.json(
          { error: "Tenant policy manager not available (not running in hosted mode)" },
          { status: 503 },
        );
      const deleted = pm.deletePolicy(tenantId);
      if (!deleted) return Response.json({ error: "policy not found" }, { status: 404 });
      logInfo("conductor", `Tenant policy deleted for: ${tenantId}`);
      return Response.json({ status: "deleted", tenant_id: tenantId });
    } catch (e: any) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }

  private handleTenantPolicyList(): Response {
    try {
      const pm = this.app.tenantPolicyManager;
      if (!pm)
        return Response.json(
          { error: "Tenant policy manager not available (not running in hosted mode)" },
          { status: 503 },
        );
      return Response.json(pm.listPolicies());
    } catch (e: any) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }

  // ── LLM proxy ────────────────────────────────────────────────────────────

  /**
   * Proxy an HTTP request to the LLM router, streaming the response back.
   * Used for the arkd -> conductor -> router proxy chain.
   */
  private async proxyToRouter(req: Request, path: string): Promise<Response> {
    const routerUrl = this.app.config.router.url;
    try {
      const headers: Record<string, string> = {};
      for (const key of ["content-type", "authorization", "accept"]) {
        const val = req.headers.get(key);
        if (val) headers[key] = val;
      }
      const init: RequestInit = { method: req.method, headers };
      if (req.method === "POST") init.body = req.body;
      const upstream = await fetch(`${routerUrl}${path}`, init);
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        },
      });
    } catch (e: any) {
      return Response.json({ error: `router proxy failed: ${e?.message ?? e}` }, { status: 502 });
    }
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

/**
 * Deliver a message to a session's channel, using arkd if available.
 * Falls back to direct HTTP to the channel port for local sessions.
 *
 * The caller passes the AppContext explicitly -- there is no module-level
 * singleton. For tenant-scoped sessions the caller can pre-scope the app.
 */
export async function deliverToChannel(
  app: AppContext,
  targetSession: Session,
  channelPort: number,
  payload: Record<string, unknown>,
): Promise<void> {
  // Try arkd delivery first (works for both local and remote)
  const computeName = targetSession.compute_name || "local";
  const tenantApp = targetSession.tenant_id ? app.forTenant(targetSession.tenant_id) : app;
  const compute = await tenantApp.computes.get(computeName);
  const provider = compute ? getProvider(providerOf(compute)) : null;
  if (provider?.getArkdUrl) {
    try {
      const arkdUrl = provider.getArkdUrl(compute!);
      const client = new ArkdClient(arkdUrl);
      const result = await client.channelDeliver({ channelPort, payload });
      if (result.delivered) return;
    } catch {
      logDebug("conductor", "arkd not available -- fall through to direct HTTP");
    }
  }

  // Fallback: direct HTTP to channel port (local only)
  try {
    await fetch(`${DEFAULT_CHANNEL_BASE_URL}:${channelPort}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    logDebug("conductor", "channel not reachable -- expected when agent hasn't started channel yet");
  }
}

// ── GitHub PR webhook payload type ──────────────────────────────────────────

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

// ── Report handling ─────────────────────────────────────────────────────────

async function handleReport(app: AppContext, sessionId: string, report: OutboundMessage): Promise<void> {
  const result = await app.sessionHooks.applyReport(sessionId, report);

  for (const evt of result.logEvents ?? []) {
    await app.events.log(sessionId, evt.type, evt.opts);
  }

  if (result.message) {
    await app.messages.send(sessionId, result.message.role, result.message.content, result.message.type);
  }

  for (const evt of result.busEvents ?? []) {
    eventBus.emit(evt.type, evt.sessionId, evt.data);
  }

  if (Object.keys(result.updates).length > 0) {
    await app.sessions.update(sessionId, result.updates);
  }

  if (result.shouldAdvance) {
    try {
      const handoff = await app.sessionHooks.mediateStageHandoff(sessionId, {
        autoDispatch: result.shouldAutoDispatch,
        source: "channel_report",
        outcome: result.outcome,
      });
      if (!handoff.ok && !handoff.blockedByVerification) {
        logWarn("conductor", `stage handoff failed for ${sessionId}: ${handoff.message}`);
      }
      if (handoff.blockedByVerification) {
        const s = await app.sessions.get(sessionId);
        await sendOSNotification(
          "Ark: Verification failed",
          `${s?.summary ?? sessionId} - ${handoff.message.slice(0, 100)}`,
        );
        return;
      }
    } catch (handoffErr: any) {
      logError("conductor", `mediateStageHandoff failed for ${sessionId}: ${handoffErr?.message ?? handoffErr}`);
    }
  }

  if (result.shouldRetry) {
    const retryResult = await app.sessionHooks.retryWithContext(sessionId, {
      maxRetries: result.retryMaxRetries,
    });
    if (retryResult.ok) {
      logInfo("conductor", `on_failure retry triggered for ${sessionId}: ${retryResult.message}`);
      app.dispatchService.dispatch(sessionId).catch((err) => {
        logError("conductor", `on_failure retry dispatch failed for ${sessionId}: ${err?.message ?? err}`);
      });
      return;
    }
    logWarn("conductor", `on_failure retry exhausted for ${sessionId}: ${retryResult.message}`);
  }

  const finalSession = await app.sessions.get(sessionId);
  if (finalSession && (report.type === "completed" || report.type === "error")) {
    const notifyTitle = report.type === "completed" ? "Stage completed" : "Session failed";
    const notifyBody = `${finalSession.summary ?? sessionId} - ${finalSession.stage ?? ""}`;
    await sendOSNotification(`Ark: ${notifyTitle}`, notifyBody);
  }

  if (result.prUrl) {
    await app.events.log(sessionId, "pr_detected", {
      actor: "agent",
      data: { pr_url: result.prUrl },
    });
  }

  try {
    const r = report as unknown as Record<string, unknown>;
    if (result.prUrl) {
      await app.artifacts.add(sessionId, "pr", [result.prUrl]);
    }
    if (Array.isArray(r.filesChanged) && r.filesChanged.length > 0) {
      await app.artifacts.add(sessionId, "file", r.filesChanged as string[]);
    }
    if (Array.isArray(r.commits) && r.commits.length > 0) {
      await app.artifacts.add(sessionId, "commit", r.commits as string[]);
    }
    const s = await app.sessions.get(sessionId);
    if (s?.branch && report.type === "completed") {
      await app.artifacts.add(sessionId, "branch", [s.branch]);
    }
  } catch {
    logDebug("conductor", "best-effort artifact tracking");
  }

  if (report.type === "completed" && app.knowledge) {
    try {
      const { indexSessionCompletion } = await import("../knowledge/indexer.js");
      const s = await app.sessions.get(sessionId);
      const changedFiles = ((report as unknown as Record<string, unknown>).filesChanged as string[] | undefined) ?? [];
      await indexSessionCompletion(app.knowledge, sessionId, s?.summary ?? "", "completed", changedFiles);
    } catch {
      logDebug("conductor", "best-effort knowledge indexing");
    }
  }

  if (report.type === "completed" && !result.prUrl) {
    const s = await app.sessions.get(sessionId);
    if (s && !s.pr_url && s.config?.github_url && s.branch) {
      const { loadRepoConfig } = await import("../repo-config.js");
      const repoConfig = s.workdir ? loadRepoConfig(s.workdir) : {};
      const autoPR = repoConfig.auto_pr !== false;

      if (autoPR) {
        await safeAsync(`auto-pr: ${sessionId}`, async () => {
          const prResult = await createWorktreePR(app, sessionId, {
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

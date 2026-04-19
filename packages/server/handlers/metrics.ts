import { execFile } from "child_process";
import { promisify } from "util";
import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { getProvider } from "../../compute/index.js";
import { getAllSessionCosts } from "../../core/observability/costs.js";
import type { MetricsSnapshotParams } from "../../types/index.js";

const execFileAsync = promisify(execFile);

export function registerMetricsHandlers(router: Router, app: AppContext): void {
  router.handle("metrics/snapshot", async (p) => {
    const { computeName } = extract<MetricsSnapshotParams>(p, []);
    const resolved = computeName ?? "local";
    const compute = app.computes.get(resolved);
    if (!compute) return { snapshot: null };
    const provider = getProvider(compute.provider);
    if (!provider?.getMetrics) return { snapshot: null };
    const snapshot = await provider.getMetrics(compute);
    return { snapshot };
  });

  router.handle("costs/read", async () => {
    const sessions = app.sessions.list({ limit: 500 });
    const { sessions: costs, total } = getAllSessionCosts(app, sessions);
    return { costs, total };
  });

  // ── Universal cost tracking endpoints ──────────────────────────────────

  router.handle("costs/summary", async (p) => {
    const params = (p ?? {}) as Record<string, any>;
    const groupBy = params.groupBy ?? "model";
    const since = params.since;
    const until = params.until;

    // tenantId is intentionally NOT forwarded from the client -- the
    // UsageRecorder enforces its own tenant scope. A remote caller cannot
    // query another tenant's costs by passing that tenant's id here.
    const summary = app.usageRecorder.getSummary({ groupBy, since, until });
    const total = app.usageRecorder.getTotalCost({ since, until });
    return { summary, total };
  });

  router.handle("costs/trend", async (p) => {
    const params = (p ?? {}) as Record<string, any>;
    const days = params.days ?? 30;

    // tenantId is intentionally NOT forwarded from the client.
    const trend = app.usageRecorder.getDailyTrend({ days });
    return { trend };
  });

  router.handle("costs/session", async (p) => {
    const params = (p ?? {}) as Record<string, any>;
    const sessionId = params.sessionId;
    if (!sessionId) throw new Error("sessionId required");

    // Double-check the session exists in the caller's tenant. getSessionCost
    // also filters by tenant, so this is defense-in-depth -- but also lets
    // us return 404-style errors for sessions that don't exist in this
    // tenant, instead of silently returning an empty cost record (which
    // could be used to probe session ids).
    const session = app.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");

    const result = app.usageRecorder.getSessionCost(sessionId);
    return result;
  });

  router.handle("costs/record", async (p) => {
    const params = (p ?? {}) as Record<string, any>;
    if (!params.sessionId || !params.model || !params.provider) {
      throw new Error("sessionId, model, and provider are required");
    }
    // Verify the session belongs to the caller's tenant. app.sessions is
    // tenant-scoped; .get() returns null for sessions in other tenants,
    // which both prevents cross-tenant write attribution and hides the
    // existence of other tenants' sessions from enumerators.
    const session = app.sessions.get(params.sessionId);
    if (!session) throw new Error("Session not found");
    // tenantId is intentionally NOT forwarded from the client -- the
    // UsageRecorder is tenant-scoped and will attribute the record to the
    // caller's tenant regardless.
    app.usageRecorder.record({
      sessionId: params.sessionId,
      model: params.model,
      provider: params.provider,
      runtime: params.runtime,
      agentRole: params.agentRole,
      usage: {
        input_tokens: params.input_tokens ?? 0,
        output_tokens: params.output_tokens ?? 0,
        cache_read_tokens: params.cache_read_tokens ?? 0,
        cache_write_tokens: params.cache_write_tokens ?? 0,
      },
      source: params.source ?? "api",
    });
    return { ok: true };
  });

  // ── Process / container actions (local compute only) ─────────────────────
  //
  // Security: these RPCs execute privileged host commands (`kill`, `docker`).
  // They are only safe on the local, single-user compute. In hosted /
  // multi-tenant mode they are refused outright -- allowing a tenant to
  // send signals to arbitrary pids on the control plane host, or to stop /
  // introspect other tenants' containers, would be a cross-tenant breach.
  // Registered in WRITE_METHODS so viewer roles and read-only web also
  // cannot reach them.
  const hostedMode = (): boolean => typeof app.config.databaseUrl === "string" && app.config.databaseUrl.length > 0;

  router.handle("compute/kill-process", async (p) => {
    if (hostedMode()) throw new Error("compute/kill-process is disabled in hosted mode");
    const params = (p ?? {}) as Record<string, any>;
    const pidRaw = params.pid;
    // Coerce to a positive integer and reject anything else. Without this
    // `String(pid)` would let a caller pass "-1" (kill every process in the
    // caller's session) or other shell-ish tokens that execFile forwards
    // verbatim as argv to `kill`.
    const pid = Math.trunc(Number(pidRaw));
    if (!Number.isFinite(pid) || pid <= 1) throw new Error("pid must be a positive integer greater than 1");
    try {
      await execFileAsync("kill", ["-15", String(pid)], { timeout: 5000 });
      return { ok: true };
    } catch (err: any) {
      throw new Error(`Failed to kill process ${pid}: ${err.message}`);
    }
  });

  // Docker container names follow a restricted charset. We match it here to
  // keep command injection impossible even if `execFile` were ever swapped
  // for a shell variant.
  const DOCKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;

  router.handle("compute/docker-logs", async (p) => {
    if (hostedMode()) throw new Error("compute/docker-logs is disabled in hosted mode");
    const params = (p ?? {}) as Record<string, any>;
    const container = params.container;
    if (typeof container !== "string" || !DOCKER_NAME_RE.test(container)) {
      throw new Error("container must be a valid docker name");
    }
    const tailNum = Math.trunc(Number(params.tail ?? 100));
    const tail = String(Number.isFinite(tailNum) && tailNum > 0 && tailNum <= 10000 ? tailNum : 100);
    try {
      const { stdout } = await execFileAsync("docker", ["logs", container, "--tail", tail], {
        timeout: 10_000,
        encoding: "utf-8",
      });
      return { logs: stdout };
    } catch (err: any) {
      throw new Error(`Failed to get logs for ${container}: ${err.message}`);
    }
  });

  router.handle("compute/docker-action", async (p) => {
    if (hostedMode()) throw new Error("compute/docker-action is disabled in hosted mode");
    const params = (p ?? {}) as Record<string, any>;
    const container = params.container;
    const action = params.action;
    if (typeof container !== "string" || !DOCKER_NAME_RE.test(container)) {
      throw new Error("container must be a valid docker name");
    }
    if (!action || !["stop", "restart"].includes(action)) throw new Error("action must be stop or restart");
    try {
      await execFileAsync("docker", [action, container], { timeout: 30_000 });
      return { ok: true };
    } catch (err: any) {
      throw new Error(`Failed to ${action} container ${container}: ${err.message}`);
    }
  });
}

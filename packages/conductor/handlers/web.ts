/**
 * Shared web handlers (local + hosted) -- RPC routes that were previously
 * REST endpoints on the web server.
 *
 * The bodies below never inspect a mode flag.
 */
import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { getHotkeys } from "../../core/hotkeys.js";
import { getThemeMode } from "../../core/theme.js";
import { getAllSessionCosts, exportCostsCsv } from "../../core/observability/costs.js";
import { getActiveProfile } from "../../core/services/profile.js";
import { cleanupWorktrees } from "../../core/services/worktree/index.js";
import { exportSession } from "../../core/session/share.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { generateOpenApiSpec } from "../../core/openapi.js";
import { DEFAULT_ARKD_URL } from "../../core/constants.js";

/** Probe a URL's /health endpoint with a short timeout. Returns true if reachable. */
async function probeHealth(baseUrl: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

export function registerWebHandlers(router: Router, app: AppContext): void {
  // ── Status ───────────────────────────────────────────────────────────────
  router.handle("status/get", async () => {
    const sessions = await app.sessions.list({ limit: 500 });
    const byStatus: Record<string, number> = {};
    for (const s of sessions) {
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    }
    return { total: sessions.length, byStatus };
  });

  // ── Daemon auto-detection ────────────────────────────────────────────────
  router.handle("daemon/status", async () => {
    const conductorUrl = app.config.conductorUrl;
    const arkdUrl = process.env.ARK_ARKD_URL || DEFAULT_ARKD_URL;

    const [conductor, arkd] = await Promise.all([probeHealth(conductorUrl), probeHealth(arkdUrl)]);

    return {
      conductor: { online: conductor, url: conductorUrl },
      arkd: { online: arkd, url: arkdUrl },
      router: { online: app.config.router.enabled },
    };
  });

  // ── Config (combined hotkeys + theme + profile + mode) ───────────────────
  //
  // `mode` is authoritative: the frontend's AppModeProvider picks the binding
  // off this field.
  router.handle("config/get", async () => ({
    hotkeys: getHotkeys(),
    theme: getThemeMode(),
    profile: getActiveProfile(),
    mode: app.mode.kind,
  }));

  // ── Cost export ──────────────────────────────────────────────────────────
  router.handle("cost/export", async (p) => {
    const { format } = extract<{ format?: string }>(p, []);
    const sessions = await app.sessions.list({ limit: 500 });
    if (format === "csv") {
      return { csv: await exportCostsCsv(app, sessions) };
    }
    return await getAllSessionCosts(app, sessions);
  });

  // ── Worktree list & cleanup ──────────────────────────────────────────────
  router.handle("worktree/list", async () => {
    const sessions = await app.sessions.list({ limit: 500 });
    const withWorktrees = sessions.filter((s) => s.workdir && s.branch);
    return { worktrees: withWorktrees };
  });

  router.handle("worktree/cleanup", async () => {
    const result = await cleanupWorktrees(app);
    return { ok: true, ...result };
  });

  // ── Session import ───────────────────────────────────────────────────────
  router.handle("session/import", async (p) => {
    const body = extract<{
      version: number;
      session: {
        ticket?: string;
        summary?: string;
        repo?: string;
        flow?: string;
        config?: any;
        group_name?: string;
        agent?: string;
      };
    }>(p, ["version", "session"]);
    if (body.version !== 1) {
      throw new RpcError(`Unsupported export version: ${body.version}`, ErrorCodes.UNSUPPORTED);
    }
    const session = await app.sessions.create({
      ticket: body.session.ticket,
      summary: body.session.summary ? `[imported] ${body.session.summary}` : "[imported session]",
      repo: body.session.repo,
      flow: body.session.flow,
      config: body.session.config,
      group_name: body.session.group_name,
    });
    if (body.session.agent) await app.sessions.update(session.id, { agent: body.session.agent });
    return { ok: true, sessionId: session.id, message: `Imported as ${session.id}` };
  });

  // ── Session export (by id, no file path) ─────────────────────────────────
  router.handle("session/export-data", async (p) => {
    const { sessionId } = extract<{ sessionId: string }>(p, ["sessionId"]);
    const data = await exportSession(app, sessionId);
    if (!data) throw new RpcError(`Session ${sessionId} not found`, ErrorCodes.SESSION_NOT_FOUND);
    return data;
  });

  // ── OpenAPI spec ─────────────────────────────────────────────────────────
  router.handle("openapi/spec", async () => generateOpenApiSpec());
}

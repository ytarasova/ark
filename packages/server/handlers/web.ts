/**
 * Shared web handlers (local + hosted) -- RPC routes that were previously
 * REST endpoints on the web server.
 *
 * Local-mode-only web handlers (mcp/attach-by-dir, mcp/detach-by-dir,
 * repo-map/get, knowledge/ingest) live in `web-local.ts` and are registered
 * conditionally in `register.ts`. The bodies below never inspect a mode flag.
 */
import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { searchSessions, searchTranscripts } from "../../core/search/search.js";
import { searchAllConversations } from "../../core/search/global-search.js";
import type { KnowledgeNode } from "../../core/knowledge/types.js";
import { getHotkeys } from "../../core/hotkeys.js";
import { getThemeMode } from "../../core/theme.js";
import { getAllSessionCosts, exportCostsCsv } from "../../core/observability/costs.js";
import { getActiveProfile } from "../../core/state/profiles.js";
import { cleanupWorktrees } from "../../core/services/worktree/index.js";
import { exportSession } from "../../core/session/share.js";
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

  // ── Search ───────────────────────────────────────────────────────────────
  router.handle("search/sessions", async (p) => {
    const { query, limit } = extract<{ query: string; limit?: number }>(p, ["query"]);
    const sessions = await searchSessions(app, query, { limit: limit ?? 50 });
    const transcripts = await searchTranscripts(app, query, { limit: limit ?? 50 });
    return { sessions, transcripts };
  });

  router.handle("search/global", async (p) => {
    const { query } = extract<{ query: string }>(p, ["query"]);
    return searchAllConversations(query);
  });

  // ── Config (combined hotkeys + theme + profile + mode) ───────────────────
  //
  // `mode` is authoritative: the frontend's AppModeProvider picks the binding
  // off this field. `hosted` is kept for back-compat with old clients until we
  // ship a breaking release; new clients should key off `mode` only.
  router.handle("config/get", async () => ({
    hotkeys: getHotkeys(),
    theme: getThemeMode(),
    profile: getActiveProfile(),
    mode: app.mode.kind,
    hosted: app.mode.kind === "hosted",
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

  // ── Conductor learnings ──────────────────────────────────────────────────
  router.handle("learning/list", async (_p) => {
    const nodes = await app.knowledge.listNodes({ type: "learning" });
    return {
      learnings: nodes.map((n: KnowledgeNode) => ({
        title: n.label,
        description: n.content ?? "",
        recurrence: (n.metadata.recurrence as number) ?? 1,
        lastSeen: n.updated_at,
      })),
    };
  });

  router.handle("learning/add", async (p) => {
    const { title, description } = extract<{ title: string; description: string; dir?: string }>(p, [
      "title",
      "description",
    ]);
    // Check for existing learning with same label and increment recurrence
    const existing = await app.knowledge.search(title, { types: ["learning"], limit: 5 });
    const match = existing.find((n) => n.label === title);
    if (match) {
      const recurrence = ((match.metadata.recurrence as number) ?? 1) + 1;
      await app.knowledge.updateNode(match.id, {
        content: description || match.content,
        metadata: { ...match.metadata, recurrence },
      });
      const updated = (await app.knowledge.getNode(match.id))!;
      return {
        ok: true,
        learning: { title: updated.label, description: updated.content, recurrence, lastSeen: updated.updated_at },
        promoted: recurrence >= 3,
      };
    }
    const id = await app.knowledge.addNode({
      type: "learning",
      label: title,
      content: description,
      metadata: { recurrence: 1 },
    });
    const node = (await app.knowledge.getNode(id))!;
    return {
      ok: true,
      learning: { title: node.label, description: node.content, recurrence: 1, lastSeen: node.updated_at },
      promoted: false,
    };
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
      throw new Error("Unsupported export version");
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
    if (!data) throw new Error("Session not found");
    return data;
  });

  // ── OpenAPI spec ─────────────────────────────────────────────────────────
  router.handle("openapi/spec", async () => generateOpenApiSpec());
}

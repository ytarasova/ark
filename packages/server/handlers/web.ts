/**
 * RPC handlers for routes previously served directly by web.ts REST endpoints.
 * These bridge the gap so the web server can use a single JSON-RPC endpoint.
 */
import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { searchSessions, searchTranscripts } from "../../core/search.js";
import { searchAllConversations } from "../../core/global-search.js";
import { getLearnings, recordLearning } from "../../core/learnings.js";
import { ingestFile, ingestDirectory } from "../../core/knowledge.js";
import { generateRepoMap } from "../../core/repo-map.js";
import { getHotkeys } from "../../core/hotkeys.js";
import { getThemeMode } from "../../core/theme.js";
import { getAllSessionCosts, exportCostsCsv } from "../../core/costs.js";
import { getActiveProfile } from "../../core/profiles.js";
import { cleanupWorktrees } from "../../core/services/session-orchestration.js";
import { exportSession } from "../../core/session-share.js";
import { addMcpServer, removeMcpServer } from "../../core/tools.js";
import { generateOpenApiSpec } from "../../core/openapi.js";

export function registerWebHandlers(router: Router, app: AppContext): void {
  // ── Status ───────────────────────────────────────────────────────────────
  router.handle("status/get", async () => {
    const sessions = app.sessions.list({ limit: 500 });
    const byStatus: Record<string, number> = {};
    for (const s of sessions) {
      byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    }
    return { total: sessions.length, byStatus };
  });

  // ── Search ───────────────────────────────────────────────────────────────
  router.handle("search/sessions", async (p) => {
    const { query, limit } = extract<{ query: string; limit?: number }>(p, ["query"]);
    const sessions = searchSessions(query, { limit: limit ?? 50 });
    const transcripts = searchTranscripts(query, { limit: limit ?? 50 });
    return { sessions, transcripts };
  });

  router.handle("search/global", async (p) => {
    const { query } = extract<{ query: string }>(p, ["query"]);
    return searchAllConversations(query);
  });

  // ── Config (combined hotkeys + theme + profile) ──────────────────────────
  router.handle("config/get", async () => ({
    hotkeys: getHotkeys(),
    theme: getThemeMode(),
    profile: getActiveProfile(),
  }));

  // ── Cost export ──────────────────────────────────────────────────────────
  router.handle("cost/export", async (p) => {
    const { format } = extract<{ format?: string }>(p, []);
    const sessions = app.sessions.list({ limit: 500 });
    if (format === "csv") {
      return { csv: exportCostsCsv(sessions) };
    }
    return getAllSessionCosts(sessions);
  });

  // ── MCP attach/detach by directory (web-specific contract) ───────────────
  router.handle("mcp/attach-by-dir", async (p) => {
    const { dir, name, config } = extract<{ dir: string; name: string; config: Record<string, unknown> }>(p, ["dir", "name", "config"]);
    addMcpServer(dir, name, config);
    return { ok: true };
  });

  router.handle("mcp/detach-by-dir", async (p) => {
    const { dir, name } = extract<{ dir: string; name: string }>(p, ["dir", "name"]);
    removeMcpServer(dir, name);
    return { ok: true };
  });

  // ── Knowledge ingestion ──────────────────────────────────────────────────
  router.handle("knowledge/ingest", async (p) => {
    const { path, directory, scope, tags, recursive } = extract<{
      path: string; directory?: boolean; scope?: string; tags?: string[]; recursive?: boolean;
    }>(p, ["path"]);
    if (directory) {
      const result = ingestDirectory(path, { scope, tags, recursive });
      return { ok: true, ...result };
    }
    const chunks = ingestFile(path, { scope, tags });
    return { ok: true, chunks };
  });

  // ── Conductor learnings ──────────────────────────────────────────────────
  router.handle("learning/list", async (p) => {
    const { dir } = extract<{ dir?: string }>(p, []);
    return { learnings: getLearnings(dir ?? ".") };
  });

  router.handle("learning/add", async (p) => {
    const { title, description, dir } = extract<{ title: string; description: string; dir?: string }>(p, ["title", "description"]);
    const result = recordLearning(dir ?? ".", title, description);
    return { ok: true, ...result };
  });

  // ── Repo map ─────────────────────────────────────────────────────────────
  router.handle("repo-map/get", async (p) => {
    const { dir } = extract<{ dir?: string }>(p, []);
    return generateRepoMap(dir ?? ".");
  });

  // ── Worktree list & cleanup ──────────────────────────────────────────────
  router.handle("worktree/list", async () => {
    const sessions = app.sessions.list({ limit: 500 });
    const withWorktrees = sessions.filter(s => s.workdir && s.branch);
    return { worktrees: withWorktrees };
  });

  router.handle("worktree/cleanup", async () => {
    const result = await cleanupWorktrees();
    return { ok: true, ...result };
  });

  // ── Session import ───────────────────────────────────────────────────────
  router.handle("session/import", async (p) => {
    const body = extract<{
      version: number;
      session: {
        ticket?: string; summary?: string; repo?: string; flow?: string;
        config?: any; group_name?: string; agent?: string;
      };
    }>(p, ["version", "session"]);
    if (body.version !== 1) {
      throw new Error("Unsupported export version");
    }
    const session = app.sessions.create({
      ticket: body.session.ticket,
      summary: body.session.summary ? `[imported] ${body.session.summary}` : "[imported session]",
      repo: body.session.repo,
      flow: body.session.flow,
      config: body.session.config,
      group_name: body.session.group_name,
    });
    if (body.session.agent) app.sessions.update(session.id, { agent: body.session.agent });
    return { ok: true, sessionId: session.id, message: `Imported as ${session.id}` };
  });

  // ── Session export (by id, no file path) ─────────────────────────────────
  router.handle("session/export-data", async (p) => {
    const { sessionId } = extract<{ sessionId: string }>(p, ["sessionId"]);
    const data = exportSession(sessionId);
    if (!data) throw new Error("Session not found");
    return data;
  });

  // ── OpenAPI spec ─────────────────────────────────────────────────────────
  router.handle("openapi/spec", async () => generateOpenApiSpec());
}

/**
 * RPC handlers for routes previously served directly by web.ts REST endpoints.
 * These bridge the gap so the web server can use a single JSON-RPC endpoint.
 */
import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { searchSessions, searchTranscripts } from "../../core/search/search.js";
import { searchAllConversations } from "../../core/search/global-search.js";
import type { KnowledgeNode } from "../../core/knowledge/types.js";
import { generateRepoMap } from "../../core/repo-map.js";
import { getHotkeys } from "../../core/hotkeys.js";
import { getThemeMode } from "../../core/theme.js";
import { getAllSessionCosts, exportCostsCsv } from "../../core/observability/costs.js";
import { getActiveProfile } from "../../core/state/profiles.js";
import { cleanupWorktrees } from "../../core/services/session-orchestration.js";
import { exportSession } from "../../core/session/share.js";
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
    const sessions = searchSessions(app, query, { limit: limit ?? 50 });
    const transcripts = searchTranscripts(app, query, { limit: limit ?? 50 });
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
    const { path: inputPath, directory } = extract<{
      path: string; directory?: boolean; scope?: string; tags?: string[]; recursive?: boolean;
    }>(p, ["path"]);
    try {
      const { indexCodebase } = await import("../../core/knowledge/indexer.js");
      const target = directory ? inputPath : inputPath;
      const result = await indexCodebase(target, app.knowledge, { incremental: true });
      return { ok: true, files: result.files, chunks: result.symbols };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  });

  // ── Conductor learnings ──────────────────────────────────────────────────
  router.handle("learning/list", async (_p) => {
    const nodes = app.knowledge.listNodes({ type: "learning" });
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
    const { title, description } = extract<{ title: string; description: string; dir?: string }>(p, ["title", "description"]);
    // Check for existing learning with same label and increment recurrence
    const existing = app.knowledge.search(title, { types: ["learning"], limit: 5 });
    const match = existing.find(n => n.label === title);
    if (match) {
      const recurrence = ((match.metadata.recurrence as number) ?? 1) + 1;
      app.knowledge.updateNode(match.id, {
        content: description || match.content,
        metadata: { ...match.metadata, recurrence },
      });
      const updated = app.knowledge.getNode(match.id)!;
      return {
        ok: true,
        learning: { title: updated.label, description: updated.content, recurrence, lastSeen: updated.updated_at },
        promoted: recurrence >= 3,
      };
    }
    const id = app.knowledge.addNode({
      type: "learning",
      label: title,
      content: description,
      metadata: { recurrence: 1 },
    });
    const node = app.knowledge.getNode(id)!;
    return {
      ok: true,
      learning: { title: node.label, description: node.content, recurrence: 1, lastSeen: node.updated_at },
      promoted: false,
    };
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
    const result = await cleanupWorktrees(app);
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
    const data = exportSession(app, sessionId);
    if (!data) throw new Error("Session not found");
    return data;
  });

  // ── OpenAPI spec ─────────────────────────────────────────────────────────
  router.handle("openapi/spec", async () => generateOpenApiSpec());
}

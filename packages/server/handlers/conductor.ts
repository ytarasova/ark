/**
 * Conductor RPC handlers.
 *
 * Surfaces conductor-side operations that were previously reached only by
 * booting an in-process AppContext from the CLI:
 *
 *   - conductor/status     read-only "is the conductor running" probe
 *   - conductor/learnings  list learning nodes from the knowledge graph
 *   - conductor/learn      record / increment a learning (promotes at >=3)
 *   - conductor/bridge     start the local messaging bridge (telegram/slack)
 *   - conductor/notify     send a one-shot message via the bridge
 *
 * Tenant scoping: every read/write goes through the tenant-scoped
 * `app.knowledge` via `resolveTenantApp(ctx)` so learnings stay isolated per
 * tenant. Bridge ops are host-local-by-nature (they read the local bridge
 * config on disk and drive outbound HTTP), so they always use the un-scoped
 * `app.config.arkDir`.
 *
 * Local-by-nature carve-outs (kept out of this handler file):
 *   - `conductor start` -- starting the conductor is part of daemon boot, not
 *     an RPC surface. Callers who want to know whether one is alive use
 *     `conductor/status`.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { createBridge } from "../../core/integrations/bridge.js";
import type { KnowledgeNode } from "../../core/knowledge/types.js";

function resolveTenantApp(app: AppContext, ctx: { tenantId?: string | null }): AppContext {
  const tenantId = ctx.tenantId ?? app.tenantId ?? app.config.authSection?.defaultTenant ?? null;
  return tenantId ? app.forTenant(tenantId) : app;
}

interface LearningView {
  id: string;
  title: string;
  description: string;
  recurrence: number;
  promoted: boolean;
  lastSeen: string;
}

function toLearningView(node: KnowledgeNode): LearningView {
  const recurrence = (node.metadata?.recurrence as number) ?? 1;
  return {
    id: node.id,
    title: node.label,
    description: node.content ?? "",
    recurrence,
    promoted: recurrence >= 3,
    lastSeen: node.updated_at,
  };
}

export function registerConductorHandlers(router: Router, app: AppContext): void {
  // ── Status ────────────────────────────────────────────────────────────────
  router.handle("conductor/status", async (_p, _notify, _ctx) => {
    const running = app.conductor !== null;
    const port = app.config.ports?.conductor ?? (app.config as any).conductorPort ?? 19100;
    return { running, port, pid: running ? process.pid : undefined };
  });

  // ── Learnings ─────────────────────────────────────────────────────────────
  router.handle("conductor/learnings", async (_p, _notify, ctx) => {
    const scoped = resolveTenantApp(app, ctx);
    const nodes = (await scoped.knowledge.listNodes({ type: "learning" })) as KnowledgeNode[];
    const learnings = nodes.map(toLearningView);
    return { learnings };
  });

  router.handle("conductor/learn", async (p, _notify, ctx) => {
    const { title, description } = extract<{ title: string; description?: string }>(p, ["title"]);
    const scoped = resolveTenantApp(app, ctx);
    const existing = await scoped.knowledge.search(title, { types: ["learning"], limit: 5 });
    const match = existing.find((n: KnowledgeNode) => n.label === title);
    if (match) {
      const recurrence = ((match.metadata?.recurrence as number) ?? 1) + 1;
      await scoped.knowledge.updateNode(match.id, {
        content: description ?? match.content,
        metadata: { ...match.metadata, recurrence },
      });
      const updated = (await scoped.knowledge.getNode(match.id))!;
      return { ok: true, learning: toLearningView(updated) };
    }
    const id = await scoped.knowledge.addNode({
      type: "learning",
      label: title,
      content: description ?? "",
      metadata: { recurrence: 1 },
    });
    const node = (await scoped.knowledge.getNode(id))!;
    return { ok: true, learning: toLearningView(node) };
  });

  // ── Bridge ────────────────────────────────────────────────────────────────
  // Bridge ops drive outbound HTTP against Telegram/Slack/Discord using a
  // config file at `~/.ark/bridge.json`. They are daemon-side-by-nature:
  // starting a bridge binds a polling loop to the daemon process, and
  // `conductor/notify` sends a one-shot message without leaving a live loop.
  router.handle("conductor/bridge", async (_p, _notify, _ctx) => {
    const bridge = createBridge(app.config.arkDir);
    if (!bridge) {
      return { ok: false, running: false, message: "no bridge config found at ~/.ark/bridge.json" };
    }
    // Wire the standard command surface that the CLI used to install inline.
    bridge.onMessage(async (msg) => {
      const text = msg.text.trim().toLowerCase();
      if (text === "/status" || text === "status") {
        await bridge.notifyStatusSummary(app);
      } else if (text === "/sessions" || text === "sessions") {
        const sessions = await app.sessions.list({ limit: 20 });
        const lines = sessions.map((s) => `• ${s.summary ?? s.id} (${s.status})`);
        await bridge.notify(lines.join("\n") || "No sessions");
      } else {
        await bridge.notify(`Unknown command: ${text}`);
      }
    });
    return { ok: true, running: true };
  });

  router.handle("conductor/notify", async (p, _notify, _ctx) => {
    const { message } = extract<{ message: string }>(p, ["message"]);
    const bridge = createBridge(app.config.arkDir);
    if (!bridge) {
      return { ok: false, message: "no bridge config found at ~/.ark/bridge.json" };
    }
    await bridge.notify(message);
    bridge.stop();
    return { ok: true };
  });
}

/**
 * knowledge-rpc.ts -- extended knowledge-graph RPC surface (Agent D).
 *
 * This module adds the RPCs the CLI's `ark knowledge *` tree needs that were
 * not previously on the wire:
 *
 *   knowledge/remember  -- store a memory node
 *   knowledge/recall    -- search memory + learning nodes
 *
 * The following live in sibling files and are NOT re-registered here (doing
 * so would clobber the existing handlers):
 *
 *   knowledge/search             -- handlers/knowledge.ts (shared)
 *   knowledge/stats              -- handlers/knowledge.ts (shared)
 *   knowledge/codebase/status    -- handlers/knowledge.ts (shared)
 *   knowledge/index              -- handlers/knowledge-local.ts (local-only)
 *   knowledge/export             -- handlers/knowledge-local.ts (local-only)
 *   knowledge/import             -- handlers/knowledge-local.ts (local-only)
 *   knowledge/ingest             -- handlers/web-local.ts (local-only, wraps kg.index)
 *
 * Every write below is tenant-scoped via the caller's `TenantContext` by
 * routing through `app.forTenant(ctx.tenantId)`. Reads do the same so
 * cross-tenant isolation holds without any handler-body `if` branches.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import type { TenantContext } from "../../core/auth/context.js";

function scoped(app: AppContext, ctx: TenantContext): AppContext {
  const tenantId = ctx.tenantId ?? app.tenantId ?? app.config.authSection.defaultTenant ?? "default";
  return app.forTenant(tenantId);
}

export function registerKnowledgeRpcHandlers(router: Router, app: AppContext): void {
  router.handle("knowledge/remember", async (p, _notify, ctx) => {
    const { content, tags, importance, scope } = extract<{
      content: string;
      tags?: string[];
      importance?: number;
      scope?: string;
    }>(p, ["content"]);
    if (typeof content !== "string" || content.length === 0) {
      throw new RpcError("content must be a non-empty string", ErrorCodes.INVALID_PARAMS);
    }
    if (importance !== undefined && (typeof importance !== "number" || importance < 0 || importance > 1)) {
      throw new RpcError("importance must be a number in [0, 1]", ErrorCodes.INVALID_PARAMS);
    }
    const t = scoped(app, ctx);
    const id = await t.knowledge.addNode({
      type: "memory",
      label: content.slice(0, 100),
      content,
      metadata: {
        tags: Array.isArray(tags) ? tags : [],
        importance: importance ?? 0.5,
        scope: scope ?? "global",
      },
    });
    return { ok: true, id };
  });

  router.handle("knowledge/recall", async (p, _notify, ctx) => {
    const { query, limit } = extract<{ query: string; limit?: number }>(p, ["query"]);
    if (typeof query !== "string" || query.length === 0) {
      throw new RpcError("query must be a non-empty string", ErrorCodes.INVALID_PARAMS);
    }
    const t = scoped(app, ctx);
    const results = await t.knowledge.search(query, {
      types: ["memory", "learning"],
      limit: typeof limit === "number" ? limit : 10,
    });
    return { results };
  });
}

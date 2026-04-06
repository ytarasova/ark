import type { Router } from "../router.js";
import * as core from "../../core/index.js";

export function registerMemoryHandlers(router: Router): void {
  router.handle("memory/list", async (p) => ({
    memories: core.listMemories(p?.scope as string | undefined),
  }));

  router.handle("memory/recall", async (p) => ({
    results: core.recall(p.query as string, {
      scope: p.scope as string | undefined,
      limit: p.limit as number | undefined,
    }),
  }));

  router.handle("memory/forget", async (p) => ({
    ok: core.forget(p.id as string),
  }));

  router.handle("memory/add", async (p) => ({
    memory: core.remember(p.content as string, {
      tags: p.tags as string[] | undefined,
      scope: p.scope as string | undefined,
      importance: p.importance as number | undefined,
    }),
  }));

  router.handle("memory/clear", async (p) => ({
    count: core.clearMemories(p?.scope as string | undefined),
  }));
}

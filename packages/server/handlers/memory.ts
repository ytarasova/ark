import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import * as core from "../../core/index.js";
import type {
  MemoryListParams,
  MemoryRecallParams,
  MemoryForgetParams,
  MemoryAddParams,
  MemoryClearParams,
} from "../../types/index.js";

export function registerMemoryHandlers(router: Router, app: AppContext): void {
  router.handle("memory/list", async (p) => {
    const { scope } = extract<MemoryListParams>(p, []);
    return { memories: core.listMemories(scope) };
  });

  router.handle("memory/recall", async (p) => {
    const { query, scope, limit } = extract<MemoryRecallParams>(p, ["query"]);
    return {
      results: core.recall(query, { scope, limit }),
    };
  });

  router.handle("memory/forget", async (p) => {
    const { id } = extract<MemoryForgetParams>(p, ["id"]);
    return { ok: core.forget(id) };
  });

  router.handle("memory/add", async (p) => {
    const { content, tags, scope, importance } = extract<MemoryAddParams>(p, ["content"]);
    return {
      memory: core.remember(content, { tags, scope, importance }),
    };
  });

  router.handle("memory/clear", async (p) => {
    const { scope } = extract<MemoryClearParams>(p, []);
    return { count: core.clearMemories(scope) };
  });
}

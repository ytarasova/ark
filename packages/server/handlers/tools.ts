import type { Router } from "../router.js";
import * as core from "../../core/index.js";

export function registerToolsHandlers(router: Router): void {
  router.handle("tools/list", async (p) => {
    const tools = core.discoverTools((p.projectRoot as string) ?? undefined);
    return { tools };
  });

  router.handle("tools/delete", async () => ({ ok: true }));

  router.handle("mcp/attach", async (p) => {
    const session = core.getSession(p.sessionId as string);
    if (!session) throw new Error("Session not found");
    core.addMcpServer(session.workdir ?? session.repo, p.server as Record<string, unknown>);
    return { ok: true };
  });

  router.handle("mcp/detach", async (p) => {
    const session = core.getSession(p.sessionId as string);
    if (!session) throw new Error("Session not found");
    core.removeMcpServer(session.workdir ?? session.repo, p.serverName as string);
    return { ok: true };
  });
}

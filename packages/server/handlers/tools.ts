import { unlinkSync, existsSync } from "fs";
import type { Router } from "../router.js";
import * as core from "../../core/index.js";

export function registerToolsHandlers(router: Router): void {
  router.handle("tools/list", async (p) => {
    const tools = core.discoverTools((p.projectRoot as string) ?? undefined);
    return { tools };
  });

  router.handle("tools/delete", async (p) => {
    const kind = p.kind as string;
    const name = p.name as string;
    const projectRoot = (p.projectRoot as string) ?? undefined;
    switch (kind) {
      case "mcp-server":
        if (projectRoot) core.removeMcpServer(projectRoot, name);
        break;
      case "command":
        if (projectRoot) core.removeCommand(projectRoot, name);
        break;
      case "claude-skill": {
        const source = p.source as string | undefined;
        if (source && source !== "builtin") {
          if (existsSync(source)) unlinkSync(source);
        }
        break;
      }
      case "ark-skill": {
        const scope = (p.scope as "project" | "global") ?? "global";
        if (p.source !== "builtin") core.deleteSkill(name, scope, projectRoot);
        break;
      }
    }
    return { ok: true };
  });

  router.handle("tools/read", async (p) => {
    const kind = p.kind as string;
    const name = p.name as string;
    const projectRoot = (p.projectRoot as string) ?? undefined;
    if (kind === "command") {
      const content = core.getCommand(projectRoot ?? ".", name);
      return { content };
    }
    if (kind === "ark-skill") {
      const skill = core.loadSkill(name, projectRoot);
      return { skill };
    }
    if (kind === "ark-recipe") {
      const recipe = core.loadRecipe(name, projectRoot);
      return { recipe };
    }
    return { content: null };
  });

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

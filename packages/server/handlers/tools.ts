import { unlinkSync, existsSync } from "fs";
import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import * as core from "../../core/index.js";
import type {
  ToolsListParams,
  ToolsDeleteParams,
  ToolsReadParams,
  McpAttachParams,
  McpDetachParams,
} from "../../types/index.js";

export function registerToolsHandlers(router: Router, app: AppContext): void {
  router.handle("tools/list", async (p) => {
    const { projectRoot } = extract<ToolsListParams>(p, []);
    const tools = core.discoverTools(projectRoot ?? undefined, app);
    return { tools };
  });

  router.handle("tools/delete", async (p) => {
    const { kind, name, projectRoot, source, scope } = extract<ToolsDeleteParams>(p, []);
    switch (kind) {
      case "mcp-server":
        if (projectRoot) core.removeMcpServer(projectRoot, name as string);
        break;
      case "command":
        if (projectRoot) core.removeCommand(projectRoot, name as string);
        break;
      case "claude-skill": {
        if (source && source !== "builtin") {
          if (existsSync(source)) unlinkSync(source);
        }
        break;
      }
      case "ark-skill": {
        const resolvedScope = (scope as "project" | "global") ?? "global";
        if (source !== "builtin") app.skills.delete(name as string, resolvedScope, projectRoot);
        break;
      }
    }
    return { ok: true };
  });

  router.handle("tools/read", async (p) => {
    const { kind, name, projectRoot } = extract<ToolsReadParams>(p, ["name", "kind"]);
    if (kind === "command") {
      const content = core.getCommand(projectRoot ?? ".", name);
      return { content };
    }
    if (kind === "ark-skill") {
      const skill = app.skills.get(name, projectRoot);
      return { skill };
    }
    if (kind === "ark-recipe") {
      const recipe = app.recipes.get(name, projectRoot);
      return { recipe };
    }
    return { content: null };
  });

  router.handle("mcp/attach", async (p) => {
    const { sessionId, server } = extract<McpAttachParams>(p, ["sessionId", "server"]);
    const session = app.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    core.addMcpServer(session.workdir ?? session.repo, server.name as string, server);
    return { ok: true };
  });

  router.handle("mcp/detach", async (p) => {
    const { sessionId, serverName } = extract<McpDetachParams>(p, ["sessionId", "serverName"]);
    const session = app.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");
    core.removeMcpServer(session.workdir ?? session.repo, serverName);
    return { ok: true };
  });
}

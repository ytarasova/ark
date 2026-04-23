import type { Command } from "commander";
import * as core from "../../../core/index.js";

/** `ark mcp-proxy <socket-path>` -- bridge stdin/stdout to a pooled MCP socket. */
export function registerMcpProxyCommand(program: Command): void {
  program
    .command("mcp-proxy")
    .description("Bridge stdin/stdout to a pooled MCP socket (internal)")
    .argument("<socket-path>")
    .action((socketPath) => {
      core.runMcpProxy(socketPath);
    });
}

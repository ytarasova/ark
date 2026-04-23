import type { Command } from "commander";
import * as core from "../../../core/index.js";
import { getInProcessApp } from "../../app-client.js";

/** `ark acp` -- headless JSON-RPC ACP server on stdin/stdout. */
export function registerAcpCommand(program: Command): void {
  program
    .command("acp")
    .description("Start headless ACP server on stdin/stdout (JSON-RPC)")
    .action(async () => {
      const app = await getInProcessApp();
      core.runAcpServer(app);
    });
}

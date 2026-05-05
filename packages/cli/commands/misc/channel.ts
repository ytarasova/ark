import type { Command } from "commander";

/** `ark channel` -- run the MCP stdio channel server (used by remote agents). */
export function registerChannelCommand(program: Command): void {
  program
    .command("channel")
    .description("Run the MCP channel server (used by remote agents)")
    .action(async () => {
      await import("../../../core/conductor/client/channel.js");
    });
}

/**
 * Barrel for the `misc` grab-bag -- one file per verb. This module keeps the
 * `registerMiscCommands(program)` entrypoint stable so `packages/cli/index.ts`
 * does not need to know the individual subcommand files.
 */

import type { Command } from "commander";
import { registerPrCommands } from "./pr.js";
import { registerWatchCommand } from "./watch.js";
import { registerClaudeCommands } from "./claude.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerArkdCommand } from "./arkd.js";
import { registerChannelCommand } from "./channel.js";
import { registerRunAgentSdkCommand } from "./run-agent-sdk.js";
import { registerConfigCommand } from "./config.js";
import { registerWebCommand } from "./web.js";
import { registerOpenApiCommand } from "./openapi.js";
import { registerMcpProxyCommand } from "./mcp-proxy.js";
import { registerInitCommand } from "./init.js";

export function registerMiscCommands(program: Command): void {
  registerPrCommands(program);
  registerWatchCommand(program);
  registerClaudeCommands(program);
  registerDoctorCommand(program);
  registerArkdCommand(program);
  registerChannelCommand(program);
  registerRunAgentSdkCommand(program);
  registerConfigCommand(program);
  registerWebCommand(program);
  registerOpenApiCommand(program);
  registerMcpProxyCommand(program);
  registerInitCommand(program);
}

export { WebCommand } from "./web.js";

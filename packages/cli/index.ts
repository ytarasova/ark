#!/usr/bin/env node
/**
 * Ark CLI - autonomous agent ecosystem.
 *
 * ark session start --repo . --summary "Add auth" --dispatch
 * ark session list
 * ark session dispatch s-abc123
 * ark session attach s-abc123
 * ark tui
 *
 * Remote mode:
 *   ark --server https://ark.company.com --token xxx session list
 *   ARK_SERVER=https://ark.company.com ARK_TOKEN=xxx ark session list
 */

import { Command } from "commander";
import chalk from "chalk";
import * as core from "../core/index.js";
import { AppContext, setApp } from "../core/app.js";
import { loadConfig } from "../core/config.js";
import { closeArkClient, setRemoteServer, isRemoteMode } from "./client.js";

import { registerSessionCommands } from "./commands/session.js";
import { registerComputeCommands } from "./commands/compute.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerFlowCommands } from "./commands/flow.js";
import { registerSkillCommands } from "./commands/skill.js";
import { registerRecipeCommands } from "./commands/recipe.js";
import { registerScheduleCommands } from "./commands/schedule.js";
import { registerWorktreeCommands } from "./commands/worktree.js";
import { registerSearchCommands } from "./commands/search.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerProfileCommands } from "./commands/profile.js";
import { registerConductorCommands } from "./commands/conductor.js";
import { registerRouterCommands } from "./commands/router.js";
import { registerRuntimeCommands } from "./commands/runtime.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerTenantCommands } from "./commands/tenant.js";
import { registerMiscCommands } from "./commands/misc.js";

// ── Resolve remote mode early (before AppContext boot) ──────────────────────
// Commander hasn't parsed yet, so peek at argv + env for --server / --token.
function peekGlobalOpts(): { server?: string; token?: string } {
  const args = process.argv;
  let server = process.env.ARK_SERVER;
  let token = process.env.ARK_TOKEN;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--server" && args[i + 1]) server = args[i + 1];
    if (args[i] === "--token" && args[i + 1]) token = args[i + 1];
  }
  return { server, token };
}

const { server: remoteServer, token: remoteToken } = peekGlobalOpts();
setRemoteServer(remoteServer, remoteToken);

// Only boot a local AppContext when not in remote mode
let app: AppContext | null = null;
if (!isRemoteMode()) {
  app = new AppContext(loadConfig(), { skipConductor: true, skipMetrics: true });
  setApp(app);
  await app.boot();
}

const program = new Command()
  .name("ark")
  .description("Ark - autonomous agent ecosystem")
  .version("0.1.0")
  .option("-p, --profile <name>", "Use a specific profile")
  .option("--server <url>", "Connect to a remote Ark control plane (e.g. https://ark.company.com)")
  .option("--token <key>", "API key for authentication with the remote server");

program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.opts();
  if (opts.profile && !isRemoteMode()) {
    core.setActiveProfile(opts.profile);
  }
  // Update remote config from parsed opts (in case env vars were used for peek)
  if (opts.server || opts.token) {
    setRemoteServer(opts.server || remoteServer, opts.token || remoteToken);
  }
});

// Register all command groups
registerSessionCommands(program);
registerComputeCommands(program);
registerAgentCommands(program);
registerFlowCommands(program);
registerSkillCommands(program);
registerRecipeCommands(program);
registerScheduleCommands(program);
registerWorktreeCommands(program);
registerSearchCommands(program);
registerMemoryCommands(program);
registerProfileCommands(program);
registerConductorCommands(program);
registerRouterCommands(program);
registerRuntimeCommands(program);
registerAuthCommands(program);
registerTenantCommands(program);
registerMiscCommands(program, app);

// ── Run ─────────────────────────────────────────────────────────────────────

await program.parseAsync(process.argv);

// Non-blocking update check (only in local mode)
if (app) {
  core.checkForUpdate(app.config.arkDir).then(latest => {
    if (latest) console.error(chalk.yellow(`Update available: v${latest}`));
  }).catch(() => {});
}

closeArkClient();
if (app) await app.shutdown();

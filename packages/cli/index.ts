#!/usr/bin/env node
/**
 * Ark CLI - autonomous agent ecosystem.
 *
 * ark session start --repo . --summary "Add auth" --dispatch
 * ark session list
 * ark session dispatch s-abc123
 * ark session attach s-abc123
 * ark tui
 */

import { Command } from "commander";
import chalk from "chalk";
import * as core from "../core/index.js";
import { AppContext, setApp } from "../core/app.js";
import { loadConfig } from "../core/config.js";
import { closeArkClient } from "./client.js";

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
import { registerAuthCommands } from "./commands/auth.js";
import { registerTenantCommands } from "./commands/tenant.js";
import { registerMiscCommands } from "./commands/misc.js";

const app = new AppContext(loadConfig(), { skipConductor: true, skipMetrics: true });
setApp(app);
await app.boot();

const program = new Command()
  .name("ark")
  .description("Ark - autonomous agent ecosystem")
  .version("0.1.0")
  .option("-p, --profile <name>", "Use a specific profile");

program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.opts();
  if (opts.profile) {
    core.setActiveProfile(opts.profile);
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
registerAuthCommands(program);
registerTenantCommands(program);
registerMiscCommands(program, app);

// ── Run ─────────────────────────────────────────────────────────────────────

await program.parseAsync(process.argv);

// Non-blocking update check
core.checkForUpdate(app.config.arkDir).then(latest => {
  if (latest) console.error(chalk.yellow(`Update available: v${latest}`));
}).catch(() => {});

closeArkClient();
await app.shutdown();

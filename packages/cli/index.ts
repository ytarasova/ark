#!/usr/bin/env node
/**
 * Ark CLI - autonomous agent ecosystem.
 *
 * ark session start --repo . --summary "Add auth" --dispatch
 * ark session list
 * ark session dispatch s-abc123
 * ark session attach s-abc123
 *
 * Remote mode:
 *   ark --server https://ark.company.com --token xxx session list
 *   ARK_SERVER=https://ark.company.com ARK_TOKEN=xxx ark session list
 */

import { Command } from "commander";
import chalk from "chalk";
import * as core from "../core/index.js";
import { AppContext } from "../core/app.js";
import { loadConfig } from "../core/config.js";
import { VERSION } from "../core/version.js";
import { closeArkClient, setLocalApp, setRemoteServer, isRemoteMode } from "./client.js";

import { registerSessionCommands } from "./commands/session.js";
import { registerComputeCommands } from "./commands/compute.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerFlowCommands } from "./commands/flow.js";
import { registerSkillCommands } from "./commands/skill.js";
import { registerRecipeCommands } from "./commands/recipe.js";
import { registerScheduleCommands } from "./commands/schedule.js";
import { registerTriggerCommands } from "./commands/trigger.js";
import { registerWorktreeCommands } from "./commands/worktree.js";
import { registerSearchCommands } from "./commands/search.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerProfileCommands } from "./commands/profile.js";
import { registerConductorCommands } from "./commands/conductor.js";
import { registerRouterCommands } from "./commands/router.js";
import { registerRuntimeCommands } from "./commands/runtime.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerTenantCommands } from "./commands/tenant.js";
import { registerKnowledgeCommands } from "./commands/knowledge.js";
import { registerCodeIntelCommands } from "./commands/code-intel.js";
import { registerEvalCommands } from "./commands/eval.js";
import { registerDashboardCommands } from "./commands/dashboard.js";
import { registerCostsCommands } from "./commands/costs.js";
import { registerServerCommands } from "./commands/server.js";
import { registerExecTryCommands } from "./commands/exec-try.js";
import { registerDaemonCommands } from "./commands/daemon.js";
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
  await app.boot();
}
setLocalApp(app);

/**
 * Most CLI commands require a local AppContext. In remote mode (when `app`
 * is null) they are unusable -- Commander still registers them so --help
 * works, but their actions fail early via this guard. Commands that work
 * purely over JSON-RPC (e.g. `session list`) take a different code path
 * and consult `getArkClient()` instead.
 */
function requireLocalApp(): AppContext {
  if (!app) {
    throw new Error(
      "This command is not supported in remote mode. Run locally or use an equivalent remote-aware command.",
    );
  }
  return app;
}

const program = new Command()
  .name("ark")
  .description("Ark - autonomous agent ecosystem")
  .version(VERSION)
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

// Register all command groups. Commands that need the local AppContext
// take it as a parameter; `requireLocalApp()` short-circuits on remote
// mode so commander doesn't need to know the difference.
const localApp =
  app ??
  (new Proxy({} as AppContext, {
    get: () => {
      throw new Error(
        "This command is not supported in remote mode. Run locally or use an equivalent remote-aware command.",
      );
    },
  }) as unknown as AppContext);
void requireLocalApp;

registerSessionCommands(program, localApp);
registerComputeCommands(program, localApp);
registerAgentCommands(program, localApp);
registerFlowCommands(program);
registerSkillCommands(program, localApp);
registerRecipeCommands(program, localApp);
registerScheduleCommands(program);
registerTriggerCommands(program);
registerWorktreeCommands(program, localApp);
registerSearchCommands(program, localApp);
registerMemoryCommands(program);
registerProfileCommands(program);
registerConductorCommands(program, localApp);
registerRouterCommands(program);
registerRuntimeCommands(program, localApp);
registerAuthCommands(program, localApp);
registerTenantCommands(program, localApp);
registerKnowledgeCommands(program, localApp);
registerCodeIntelCommands(program, localApp);
registerEvalCommands(program);
registerDashboardCommands(program, app);
registerCostsCommands(program, localApp);
registerServerCommands(program);
registerDaemonCommands(program);
registerExecTryCommands(program, app);
registerMiscCommands(program, app);

// ── Run ─────────────────────────────────────────────────────────────────────

await program.parseAsync(process.argv);

// Non-blocking update check (only in local mode)
if (app) {
  core
    .checkForUpdate(app.config.arkDir)
    .then((latest) => {
      if (latest) console.error(chalk.yellow(`Update available: v${latest}`));
    })
    .catch(() => {});
}

closeArkClient();
if (app) await app.shutdown();

#!/usr/bin/env node
/**
 * Ark CLI - autonomous agent ecosystem.
 *
 *   ark session start --repo . --summary "Add auth" --dispatch
 *   ark session list
 *   ark session dispatch s-abc123
 *   ark session attach s-abc123
 *
 * Remote mode:
 *   ark --server https://ark.company.com --token xxx session list
 *   ARK_SERVER=https://ark.company.com ARK_TOKEN=xxx ark session list
 *
 * Local mode:
 *   The CLI is a pure client. If no server daemon is reachable on
 *   config.ports.server, one is auto-spawned via `ark server daemon start`
 *   the first time a command asks for a client. Subsequent invocations
 *   connect to the now-running daemon. See `./app-client.ts`.
 */

import { Command } from "commander";
import chalk from "chalk";
import * as core from "../core/index.js";
import { VERSION } from "../core/version.js";
import { closeArkClient, setRemoteServer, isRemoteMode, shutdownInProcessApp } from "./app-client.js";

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
import { registerTeamCommands } from "./commands/team.js";
import { registerUserCommands } from "./commands/user.js";
import { registerKnowledgeCommands } from "./commands/knowledge.js";
import { registerCodeIntelCommands } from "./commands/code-intel.js";
import { registerWorkspaceCommands } from "./commands/workspace.js";
import { registerEvalCommands } from "./commands/eval.js";
import { registerDashboardCommands } from "./commands/dashboard.js";
import { registerCostsCommands } from "./commands/costs.js";
import { registerServerCommands } from "./commands/server.js";
import { registerExecTryCommands } from "./commands/exec-try.js";
import { registerDaemonCommands } from "./commands/daemon.js";
import { registerMiscCommands } from "./commands/misc.js";
import { registerSageCommands } from "./commands/sage.js";
import { registerDbCommands } from "./commands/db.js";
import { registerSecretsCommands } from "./commands/secrets.js";
// --- BEGIN agent-G ---
import { registerClusterCommands } from "./commands/cluster.js";
import { registerTenantConfigCommands } from "./commands/tenant-config.js";
// --- END agent-G ---

// ── Resolve remote mode early (before Commander parses) ─────────────────────
// The client helper looks at _remoteServerUrl; stash the values we'll see
// on argv so it's set before any command runs.
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

// Register every command group. Commands pull state from the
// `app-client.ts` helpers on demand: remote vs. local-spawned daemon
// for everything that has an RPC surface, `getInProcessApp()` for the
// few commands that still need direct AppContext access.
registerSessionCommands(program);
registerComputeCommands(program);
registerAgentCommands(program);
registerFlowCommands(program);
registerSkillCommands(program);
registerRecipeCommands(program);
registerScheduleCommands(program);
registerTriggerCommands(program);
registerWorktreeCommands(program);
registerSearchCommands(program);
registerMemoryCommands(program);
registerProfileCommands(program);
registerConductorCommands(program);
registerRouterCommands(program);
registerRuntimeCommands(program);
registerAuthCommands(program);
registerTenantCommands(program);
registerTeamCommands(program);
registerUserCommands(program);
registerKnowledgeCommands(program);
registerCodeIntelCommands(program);
registerWorkspaceCommands(program);
registerEvalCommands(program);
registerDashboardCommands(program);
registerCostsCommands(program);
registerServerCommands(program);
registerDaemonCommands(program);
registerExecTryCommands(program);
registerMiscCommands(program);
registerSageCommands(program);
registerDbCommands(program);
registerSecretsCommands(program);

// --- BEGIN agent-G ---
registerClusterCommands(program);
registerTenantConfigCommands(program);
// --- END agent-G ---

// ── Run ─────────────────────────────────────────────────────────────────────

await program.parseAsync(process.argv);

// Non-blocking update check -- skip in remote mode since we don't own
// a local arkDir to cache the version file into.
if (!isRemoteMode()) {
  const arkDir = (process.env.ARK_DIR ?? `${process.env.HOME}/.ark`) as string;
  core
    .checkForUpdate(arkDir)
    .then((latest) => {
      if (latest) console.error(chalk.yellow(`Update available: v${latest}`));
    })
    .catch(() => {});
}

closeArkClient();
await shutdownInProcessApp();

#!/usr/bin/env bun
/**
 * Generates docs/cli-reference.md from the live Commander.js command tree.
 * Usage: bun run scripts/generate-cli-docs.ts
 * Or via: make docs-cli
 *
 * Uses dynamic imports so that modules with problematic transitive
 * dependencies (e.g. AWS SDK in compute) degrade gracefully rather
 * than aborting the whole run.
 */

import { writeFileSync } from "fs";
import { Command } from "commander";
import { VERSION } from "../packages/core/version.js";

// ── Build the program (mirrors packages/cli/index.ts, without parseAsync) ─────

const program = new Command()
  .name("ark")
  .description("Ark - autonomous agent ecosystem")
  .version(VERSION)
  .option("-p, --profile <name>", "Use a specific profile")
  .option("--server <url>", "Connect to a remote Ark control plane (e.g. https://ark.company.com)")
  .option("--token <key>", "API key for authentication with the remote server");

// Register a group of commands. If the import fails (e.g. transitive AWS SDK
// module-resolution issue in Bun), fall back to a minimal stub so the rest of
// the docs are still generated.
async function register(
  importFn: () => Promise<Record<string, (prog: Command) => void>>,
  fnName: string,
): Promise<void> {
  try {
    const mod = await importFn();
    mod[fnName](program);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`warn: skipped ${fnName} (${msg.slice(0, 120)})\n`);
  }
}

await register(() => import("../packages/cli/commands/session/index.js"), "registerSessionCommands");
await register(() => import("../packages/cli/commands/compute/index.js"), "registerComputeCommands");
await register(() => import("../packages/cli/commands/agent.js"), "registerAgentCommands");
await register(() => import("../packages/cli/commands/flow.js"), "registerFlowCommands");
await register(() => import("../packages/cli/commands/skill.js"), "registerSkillCommands");
await register(() => import("../packages/cli/commands/recipe.js"), "registerRecipeCommands");
await register(() => import("../packages/cli/commands/schedule.js"), "registerScheduleCommands");
await register(() => import("../packages/cli/commands/trigger.js"), "registerTriggerCommands");
await register(() => import("../packages/cli/commands/worktree.js"), "registerWorktreeCommands");
await register(() => import("../packages/cli/commands/search.js"), "registerSearchCommands");
await register(() => import("../packages/cli/commands/memory.js"), "registerMemoryCommands");
await register(() => import("../packages/cli/commands/profile.js"), "registerProfileCommands");
await register(() => import("../packages/cli/commands/conductor.js"), "registerConductorCommands");
await register(() => import("../packages/cli/commands/router.js"), "registerRouterCommands");
await register(() => import("../packages/cli/commands/runtime.js"), "registerRuntimeCommands");
await register(() => import("../packages/cli/commands/auth.js"), "registerAuthCommands");
await register(() => import("../packages/cli/commands/tenant.js"), "registerTenantCommands");
await register(() => import("../packages/cli/commands/team.js"), "registerTeamCommands");
await register(() => import("../packages/cli/commands/user.js"), "registerUserCommands");
await register(() => import("../packages/cli/commands/knowledge.js"), "registerKnowledgeCommands");
await register(() => import("../packages/cli/commands/code-intel.js"), "registerCodeIntelCommands");
await register(() => import("../packages/cli/commands/workspace.js"), "registerWorkspaceCommands");
await register(() => import("../packages/cli/commands/eval.js"), "registerEvalCommands");
await register(() => import("../packages/cli/commands/dashboard.js"), "registerDashboardCommands");
await register(() => import("../packages/cli/commands/costs.js"), "registerCostsCommands");
await register(() => import("../packages/cli/commands/server.js"), "registerServerCommands");
await register(() => import("../packages/cli/commands/exec-try.js"), "registerExecTryCommands");
await register(() => import("../packages/cli/commands/daemon.js"), "registerDaemonCommands");
await register(() => import("../packages/cli/commands/misc.js"), "registerMiscCommands");
await register(() => import("../packages/cli/commands/db.js"), "registerDbCommands");
await register(() => import("../packages/cli/commands/secrets.js"), "registerSecretsCommands");
await register(() => import("../packages/cli/commands/cluster.js"), "registerClusterCommands");
await register(() => import("../packages/cli/commands/tenant-config.js"), "registerTenantConfigCommands");

// ── Markdown helpers ──────────────────────────────────────────────────────────

function argSyntax(arg: any): string {
  const n = arg.variadic ? `${arg.name()}...` : arg.name();
  return arg.required ? `<${n}>` : `[${n}]`;
}

function buildSynopsis(cmd: Command, path: string[]): string {
  const parts = [...path];
  const visibleOpts = cmd.options.filter((o: any) => !o.hidden);
  if (visibleOpts.length) parts.push("[options]");
  for (const a of cmd.registeredArguments) parts.push(argSyntax(a));
  return parts.join(" ");
}

function renderArguments(cmd: Command): string[] {
  if (!cmd.registeredArguments.length) return [];
  const lines = ["**Arguments:**\n", "| Argument | Required | Description |", "|----------|----------|-------------|"];
  for (const a of cmd.registeredArguments) {
    const cell = a.variadic ? `\`${a.name()}...\`` : `\`${a.name()}\``;
    lines.push(`| ${cell} | ${a.required ? "yes" : "no"} | ${a.description ?? ""} |`);
  }
  lines.push("");
  return lines;
}

function renderOptions(cmd: Command): string[] {
  const opts = cmd.options.filter((o: any) => !o.hidden && o.flags !== "-h, --help" && o.flags !== "-V, --version");
  if (!opts.length) return [];
  const lines = ["**Options:**\n", "| Flag | Default | Description |", "|------|---------|-------------|"];
  for (const o of opts) {
    let def = "";
    if (o.defaultValue !== undefined && o.defaultValue !== false && o.defaultValue !== "") {
      def = `\`${JSON.stringify(o.defaultValue)}\``;
    }
    const req = o.mandatory ? " *(required)*" : "";
    lines.push(`| \`${o.flags}\` | ${def} | ${o.description}${req} |`);
  }
  lines.push("");
  return lines;
}

// ── Recursive tree walker ─────────────────────────────────────────────────────

function walk(cmd: Command, path: string[], out: string[]): void {
  const curPath = [...path, cmd.name()];
  const depth = curPath.length; // 1=ark, 2=ark/session, 3=ark/session/start ...

  if (depth > 1) {
    const hashes = "#".repeat(Math.min(depth, 4));
    out.push(`${hashes} \`${curPath.join(" ")}\``);
    out.push("");
    if (cmd.description()) {
      out.push(cmd.description());
      out.push("");
    }
    out.push(`**Synopsis:** \`${buildSynopsis(cmd, curPath)}\``);
    out.push("");
    out.push(...renderArguments(cmd));
    out.push(...renderOptions(cmd));
  }

  for (const sub of cmd.commands) {
    walk(sub, curPath, out);
  }
}

// ── Assemble output ───────────────────────────────────────────────────────────

const out: string[] = [
  "# Ark CLI Reference",
  "",
  "> Auto-generated from the Commander.js tree. Run `make docs-cli` to regenerate.",
  "",
  `> Version: ${VERSION}`,
  "",
  "## Usage",
  "",
  "```",
  "ark [options] <command>",
  "```",
  "",
  "## Global Options",
  "",
  "| Flag | Description |",
  "|------|-------------|",
];

for (const o of program.options.filter((o: any) => o.flags !== "-h, --help" && o.flags !== "-V, --version")) {
  out.push(`| \`${o.flags}\` | ${o.description} |`);
}

out.push("");
out.push("## Commands");
out.push("");
out.push("| Command | Description |");
out.push("|---------|-------------|");

for (const sub of program.commands) {
  const anchor = sub.name().replace(/[^a-z0-9]/g, "-");
  out.push(`| [\`ark ${sub.name()}\`](#ark-${anchor}) | ${sub.description()} |`);
}

out.push("");

for (const sub of program.commands) {
  walk(sub, ["ark"], out);
}

out.push("");

// ── Write ─────────────────────────────────────────────────────────────────────

const content = out.join("\n");
writeFileSync("docs/cli-reference.md", content);
console.log(`docs/cli-reference.md written (${content.length} bytes, ${program.commands.length} top-level commands)`);

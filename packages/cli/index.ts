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
import { resolve, basename, join, dirname } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { execSync, execFileSync } from "child_process";
import YAML from "yaml";
import * as core from "../core/index.js";
import { getProvider } from "../compute/index.js";
import { AppContext, setApp } from "../core/app.js";
import { loadConfig } from "../core/config.js";
import { getArkClient, closeArkClient } from "./client.js";

const app = new AppContext(loadConfig(), { skipConductor: true, skipMetrics: true });
await app.boot();
setApp(app);

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

// ── Session commands ────────────────────────────────────────────────────────

const session = program.command("session").description("Manage SDLC flow sessions");

session.command("start")
  .description("Start a new session")
  .argument("[ticket]", "External ticket reference (Jira key, GitHub issue, etc.)")
  .option("-r, --repo <path>", "Repository path or name")
  .option("-s, --summary <text>", "Task summary")
  .option("-p, --flow <name>", "Flow name", "default")
  .option("-c, --compute <name>", "Compute name")
  .option("-g, --group <name>", "Group name")
  .option("-d, --dispatch", "Auto-dispatch the first stage agent")
  .option("-a, --attach", "Dispatch and attach to the session")
  .option("--claude-session <id>", "Create from an existing Claude Code session (use 'ark claude list' to find IDs)")
  .option("--recipe <name>", "Create session from a recipe template")
  .action(async (ticket, opts) => {
    const ark = await getArkClient();
    let workdir: string | undefined;
    let repo = opts.repo;
    if (repo) {
      const rp = resolve(repo);
      if (existsSync(rp)) {
        workdir = rp;
        if (repo === "." || repo === "./") repo = basename(rp);
      }
    }

    // Import from Claude session if specified
    let claudeSessionId: string | undefined;
    if (opts.claudeSession) {
      const cs = await core.getClaudeSession(opts.claudeSession);
      if (!cs) {
        console.log(chalk.red(`Claude session '${opts.claudeSession}' not found. Run 'ark claude list' to see available sessions.`));
        return;
      }
      claudeSessionId = cs.sessionId;
      if (!opts.summary) opts.summary = cs.summary?.slice(0, 100) || `Imported from ${cs.sessionId.slice(0, 8)}`;
      if (!repo) { repo = cs.project; }
      if (!workdir) { workdir = cs.project; }
      console.log(chalk.dim(`Importing Claude session ${cs.sessionId.slice(0, 8)} from ${cs.project}`));
    }

    // Load recipe defaults if specified (CLI flags override recipe values)
    let recipeAgent: string | undefined;
    if (opts.recipe) {
      try {
        const recipe = await ark.recipeRead(opts.recipe);
        const instance = core.instantiateRecipe(recipe, {
          ...(opts.summary ? { summary: opts.summary } : {}),
          ...(opts.repo ? { repo: opts.repo } : {}),
        });
        if (!opts.summary && instance.summary) opts.summary = instance.summary;
        if (!opts.summary) opts.summary = recipe.description;
        if (!opts.flow || opts.flow === "default") opts.flow = instance.flow;
        if (!opts.compute && instance.compute) opts.compute = instance.compute;
        if (!opts.group && instance.group) opts.group = instance.group;
        if (!repo && instance.repo) { repo = instance.repo; }
        recipeAgent = instance.agent;
        console.log(chalk.dim(`Using recipe '${recipe.name}' (${recipe._source})`));
      } catch {
        console.error(chalk.red(`Recipe not found: ${opts.recipe}`)); process.exit(1);
      }
    }

    // Sanitize session name: alphanumeric, dash, underscore only
    const rawName = opts.summary ?? ticket ?? "";
    const summary = rawName.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || rawName;

    const s = await ark.sessionStart({
      ticket, summary,
      repo, flow: opts.flow, compute_name: opts.compute,
      agent: recipeAgent,
      workdir, group_name: opts.group,
    });

    if (claudeSessionId) {
      await ark.sessionUpdate(s.id, { claude_session_id: claudeSessionId });
      console.log(chalk.dim(`  Bound to Claude session: ${claudeSessionId.slice(0, 8)} (will use --resume on dispatch)`));
    }

    console.log(chalk.green(`Session ${s.id} created`));
    console.log(`  Summary:  ${s.summary ?? "-"}`);
    console.log(`  Repo:     ${s.repo ?? "-"}`);
    console.log(`  Flow:     ${s.flow}`);
    console.log(`  Stage:    ${s.stage ?? "-"}`);
    if (workdir) console.log(`  Workdir:  ${workdir}`);

    if (opts.dispatch || opts.attach) {
      const result = await ark.sessionDispatch(s.id);
      if (result.ok) {
        console.log(chalk.green(`Agent dispatched - session: ${result.message}`));
        if (opts.attach) {
          const cmd = core.attachCommand(result.message);
          execSync(cmd, { stdio: "inherit" });
        }
      } else {
        console.log(chalk.red(`Dispatch failed: ${result.message}`));
      }
    }
  });

session.command("list")
  .description("List all sessions")
  .option("-s, --status <status>", "Filter by status")
  .option("-r, --repo <repo>", "Filter by repo")
  .option("-g, --group <group>", "Filter by group")
  .action(async (opts) => {
    const ark = await getArkClient();
    const sessions = await ark.sessionList({ ...opts, groupPrefix: core.profileGroupPrefix() || undefined });
    if (!sessions.length) {
      console.log(chalk.dim("No sessions. Start one: ark session start --repo . --summary 'task'"));
      return;
    }
    const icons: Record<string, string> = {
      running: "●", waiting: "⏸", pending: "○", ready: "◎",
      completed: "✓", failed: "✕", blocked: "■",
    };
    const colors: Record<string, (s: string) => string> = {
      running: chalk.blue, waiting: chalk.yellow, completed: chalk.green,
      failed: chalk.red, blocked: chalk.yellow,
    };
    for (const s of sessions) {
      const icon = icons[s.status] ?? "?";
      const color = colors[s.status] ?? chalk.dim;
      const group = s.group_name ? chalk.dim(`[${s.group_name}] `) : "";
      const summary = s.summary ?? s.ticket ?? s.repo ?? "-";
      console.log(`  ${color(icon)} ${s.id}  ${group}${summary.slice(0, 40)}  ${s.stage ?? "-"}  ${s.status}`);
    }
  });

session.command("show")
  .description("Show session details")
  .argument("<id>", "Session ID")
  .action(async (id) => {
    const ark = await getArkClient();
    const { session: s } = await ark.sessionRead(id);
    if (!s) { console.log(chalk.red(`Session ${id} not found`)); return; }
    console.log(chalk.bold(`\n${s.ticket ?? s.id}: ${s.summary ?? ""}`));
    console.log(`  ID:       ${s.id}`);
    console.log(`  Status:   ${s.status}`);
    console.log(`  Stage:    ${s.stage ?? "-"}`);
    console.log(`  Repo:     ${s.repo ?? "-"}`);
    console.log(`  Flow:     ${s.flow}`);
    if (s.agent) console.log(`  Agent:    ${s.agent}`);
    if (s.error) console.log(chalk.red(`  Error:    ${s.error}`));
    if (s.breakpoint_reason) console.log(chalk.yellow(`  Waiting:  ${s.breakpoint_reason}`));
  });

session.command("dispatch")
  .description("Dispatch the agent for the current stage")
  .argument("<id>", "Session ID")
  .action(async (id) => {
    const ark = await getArkClient();
    const r = await ark.sessionDispatch(id);
    console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
  });

session.command("stop")
  .description("Stop a session")
  .argument("<id>")
  .action(async (id) => {
    const ark = await getArkClient();
    try {
      await ark.sessionStop(id);
      console.log(chalk.yellow("Stopped"));
    } catch (e: any) {
      console.log(chalk.red(e.message));
    }
  });

session.command("resume")
  .description("Resume a stopped/paused session")
  .argument("<id>")
  .action(async (id) => {
    const ark = await getArkClient();
    const r = await ark.sessionResume(id);
    console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
  });

session.command("advance")
  .description("Advance to the next flow stage")
  .argument("<id>")
  .option("-f, --force", "Force past gate")
  .action(async (id, opts) => {
    const ark = await getArkClient();
    const r = await ark.sessionAdvance(id, opts.force);
    console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
  });

session.command("complete")
  .description("Mark current stage done and advance")
  .argument("<id>")
  .action(async (id) => {
    const ark = await getArkClient();
    try {
      await ark.sessionComplete(id);
      console.log(chalk.green("Completed"));
    } catch (e: any) {
      console.log(chalk.red(e.message));
    }
  });

session.command("pause")
  .description("Pause a session")
  .argument("<id>")
  .option("-r, --reason <text>")
  .action(async (id, opts) => {
    const ark = await getArkClient();
    const r = await ark.sessionPause(id, opts.reason);
    console.log(r.ok ? chalk.yellow("Paused") : chalk.red(r.message));
  });

session.command("attach")
  .description("Attach to a running agent session")
  .argument("<id>")
  .action(async (id) => {
    const ark = await getArkClient();
    let { session: s } = await ark.sessionRead(id);
    if (!s) { console.log(chalk.red("Not found")); return; }
    if (!s.session_id) {
      console.log(chalk.yellow("No active session. Dispatching..."));
      const r = await ark.sessionDispatch(id);
      if (!r.ok) { console.log(chalk.red(r.message)); return; }
      s = (await ark.sessionRead(id)).session;
    }
    const cmd = core.attachCommand(s.session_id!);
    require("child_process").execSync(cmd, { stdio: "inherit" });
  });

session.command("output")
  .description("Show live output from a running session")
  .argument("<id>")
  .option("-n, --lines <n>", "Number of lines", "30")
  .action(async (id, opts) => {
    const ark = await getArkClient();
    const output = await ark.sessionOutput(id, Number(opts.lines));
    console.log(output || chalk.dim("No output"));
  });

session.command("send")
  .description("Send a message to a running Claude session")
  .argument("<id>")
  .argument("<message>")
  .action(async (id, message) => {
    const ark = await getArkClient();
    try {
      await ark.messageSend(id, message);
      console.log(chalk.green("Sent"));
    } catch (e: any) {
      console.log(chalk.red(e.message));
    }
  });

session.command("undelete")
  .description("Restore a recently deleted session (within 90s)")
  .argument("<id>")
  .action(async (id) => {
    const ark = await getArkClient();
    try {
      const result = await ark.sessionUndelete(id);
      console.log(chalk.green(result?.message ?? "Restored"));
    } catch (e: any) {
      console.log(chalk.red(e.message));
    }
  });

session.command("fork")
  .description("Fork a session (branches the conversation)")
  .argument("<id>")
  .option("-t, --task <text>", "Task description for forked session")
  .option("-g, --group <name>", "Group for forked session")
  .option("-d, --dispatch", "Auto-dispatch")
  .action(async (id, opts) => {
    const ark = await getArkClient();
    try {
      const forked = await ark.sessionClone(id, opts.task);
      if (opts.group) await ark.sessionUpdate(forked.id, { group_name: opts.group });
      console.log(chalk.green(`Forked → ${forked.id}`));
      if (opts.dispatch) await ark.sessionDispatch(forked.id);
    } catch (e: any) {
      console.log(chalk.red(e.message));
    }
  });

session.command("clone")
  .description("Alias for fork (branches the conversation)")
  .argument("<id>")
  .option("-t, --task <text>", "Task description for forked session")
  .option("-g, --group <name>", "Group for forked session")
  .option("-d, --dispatch", "Auto-dispatch")
  .action(async (id, opts) => {
    const ark = await getArkClient();
    try {
      const cloned = await ark.sessionClone(id, opts.task);
      if (opts.group) await ark.sessionUpdate(cloned.id, { group_name: opts.group });
      console.log(chalk.green(`Forked → ${cloned.id}`));
      if (opts.dispatch) await ark.sessionDispatch(cloned.id);
    } catch (e: any) {
      console.log(chalk.red(e.message));
    }
  });

session.command("handoff")
  .description("Hand off to a different agent")
  .argument("<id>")
  .argument("<agent>")
  .option("-i, --instructions <text>")
  .action(async (id, agent, opts) => {
    const ark = await getArkClient();
    const r = await ark.sessionHandoff(id, agent, opts.instructions);
    console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
  });

session.command("spawn")
  .description("Spawn a child session for parallel work")
  .argument("<parent-id>")
  .argument("<task>")
  .action(async (parentId, task) => {
    const ark = await getArkClient();
    try {
      const forked = await ark.sessionFork(parentId, task);
      console.log(chalk.green(`Spawned → ${forked.id}`));
    } catch (e: any) {
      console.log(chalk.red(e.message));
    }
  });

session.command("spawn-subagent")
  .description("Spawn a subagent with optional model/agent override")
  .argument("<parent-id>")
  .argument("<task>")
  .option("-m, --model <model>", "Model override (e.g., haiku, sonnet, opus)")
  .option("-a, --agent <agent>", "Agent override")
  .option("-g, --group <name>", "Group name")
  .option("-d, --dispatch", "Auto-dispatch after spawning")
  .action(async (parentId, task, opts) => {
    const ark = await getArkClient();
    const r = await ark.sessionSpawn(parentId, {
      task,
      agent: opts.agent,
      model: opts.model,
      group_name: opts.group,
    });
    if (r.ok) {
      console.log(chalk.green(`Subagent spawned → ${r.sessionId}`));
      if (opts.dispatch && r.sessionId) {
        const d = await ark.sessionDispatch(r.sessionId);
        console.log(d.ok ? chalk.green(`Dispatched: ${d.message}`) : chalk.red(d.message));
      }
    } else {
      console.log(chalk.red(r.message));
    }
  });

session.command("join")
  .description("Join all forked children")
  .argument("<parent-id>")
  .option("-f, --force")
  .action(async (parentId, opts) => {
    const ark = await getArkClient();
    const r = await ark.sessionJoin(parentId, opts.force);
    console.log(r.ok ? chalk.green(r.message) : chalk.yellow(r.message));
  });

session.command("events")
  .description("Show event history")
  .argument("<id>")
  .action(async (id) => {
    const ark = await getArkClient();
    const { formatEvent } = await import("../tui/helpers/formatEvent.js");
    const events = await ark.sessionEvents(id);
    for (const e of events) {
      const ts = e.created_at.slice(11, 16);
      const msg = formatEvent(e.type, e.data ?? undefined);
      console.log(`  ${chalk.dim(ts)}  ${msg}`);
    }
  });

session.command("delete")
  .description("Delete sessions")
  .argument("<ids...>")
  .action(async (ids: string[]) => {
    const ark = await getArkClient();
    for (const id of ids) {
      try {
        await ark.sessionDelete(id);
        console.log(chalk.green("Session deleted (undo available for 90s)"));
        console.log(chalk.dim(`  Run 'ark session undelete ${id}' within 90s to undo`));
      } catch (e: any) {
        console.log(chalk.red(`Session ${id}: ${e.message}`));
      }
    }
  });

session.command("group")
  .description("Assign a session to a group")
  .argument("<id>")
  .argument("<group>")
  .action(async (id, group) => {
    const ark = await getArkClient();
    await ark.sessionUpdate(id, { group_name: group });
    console.log(chalk.green(`${id} → group '${group}'`));
  });

session.command("export")
  .description("Export session to file")
  .argument("<id>")
  .argument("[file]")
  .action((id, file) => {
    const outPath = file ?? `session-${id}.json`;
    if (core.exportSessionToFile(id, outPath)) {
      console.log(chalk.green(`Exported to ${outPath}`));
    } else {
      console.log(chalk.red("Session not found"));
    }
  });

session.command("import")
  .description("Import session from file")
  .argument("<file>")
  .action((file) => {
    const result = core.importSessionFromFile(file);
    console.log(result.ok ? chalk.green(result.message) : chalk.red(result.message));
  });

// ── PR commands ──────────────────────────────────────────────────────────────

const pr = program.command("pr").description("Manage PR-bound sessions");

pr.command("list")
  .description("List sessions bound to PRs")
  .action(async () => {
    const ark = await getArkClient();
    const sessions = await ark.sessionList({ limit: 50, groupPrefix: core.profileGroupPrefix() || undefined });
    const prSessions = sessions.filter((s: any) => s.pr_url);
    if (prSessions.length === 0) {
      console.log(chalk.yellow("No PR-bound sessions."));
      return;
    }
    for (const s of prSessions) {
      const icon = s.status === "running" ? "●" : s.status === "completed" ? "✓" : s.status === "failed" ? "✕" : "○";
      console.log(`  ${icon} ${chalk.dim(s.id)}  ${s.pr_url}  ${s.summary || ""}`);
    }
  });

pr.command("status")
  .description("Show session bound to a PR URL")
  .argument("<pr-url>", "GitHub PR URL")
  .action((prUrl) => {
    const { findSessionByPR } = require("../core/github-pr.js");
    const session = findSessionByPR(prUrl);
    if (!session) {
      console.log(chalk.yellow(`No session for ${prUrl}`));
      return;
    }
    console.log(`  Session: ${session.id}`);
    console.log(`  Status:  ${session.status}`);
    console.log(`  Flow:    ${session.flow}`);
    console.log(`  Stage:   ${session.stage || "-"}`);
    console.log(`  Summary: ${session.summary || "-"}`);
  });

// ── Watch (Issue Poller) ─────────────────────────────────────────────────────

program.command("watch")
  .description("Watch GitHub issues with a label and auto-create sessions")
  .option("-l, --label <label>", "GitHub label to watch", "ark")
  .option("-d, --dispatch", "Auto-dispatch created sessions")
  .option("-i, --interval <ms>", "Poll interval in ms", "60000")
  .action(async (opts) => {
    const { startIssuePoller } = await import("../core/issue-poller.js");
    const label = opts.label;
    const intervalMs = parseInt(opts.interval, 10);

    console.log(chalk.blue(`Watching issues labeled '${label}' (poll every ${intervalMs / 1000}s)${opts.dispatch ? " — auto-dispatch on" : ""}`));
    console.log(chalk.dim("Press Ctrl+C to stop.\n"));

    const poller = startIssuePoller({
      label,
      intervalMs,
      autoDispatch: opts.dispatch,
    });

    // Keep the process alive until interrupted
    process.on("SIGINT", () => {
      poller.stop();
      console.log(chalk.dim("\nStopped."));
      process.exit(0);
    });

    // Prevent the process from exiting
    await new Promise(() => {});
  });

// ── Agent commands ──────────────────────────────────────────────────────────

const agent = program.command("agent").description("Manage agent definitions");

agent.command("list").description("List agents").option("--project <dir>", "Project root").action(async (opts) => {
  const ark = await getArkClient();
  const agents = await ark.agentList();
  for (const a of agents) {
    const src = (a._source === "project" ? "P" : a._source === "global" ? "G" : "B").padEnd(2);
    console.log(`  ${src} ${a.name.padEnd(16)} ${a.model.padEnd(8)} T:${a.tools.length} M:${a.mcp_servers.length} S:${a.skills.length} R:${a.memories.length}  ${a.description.slice(0, 40)}`);
  }
});

agent.command("show").description("Show agent details").argument("<name>").action(async (name) => {
  const ark = await getArkClient();
  try {
    const { agent: a } = await ark.rpc("agent/read", { name });
    console.log(chalk.bold(`\n${a.name}`) + chalk.dim(` (${a._source})`));
    console.log(`  Model:      ${a.model}`);
    console.log(`  Max turns:  ${a.max_turns}`);
    console.log(`  Tools:      ${a.tools.join(", ")}`);
    console.log(`  MCPs:       ${a.mcp_servers.length ? a.mcp_servers.join(", ") : "-"}`);
    console.log(`  Skills:     ${a.skills.length ? a.skills.join(", ") : "-"}`);
    console.log(`  Memories:   ${a.memories.length ? a.memories.join(", ") : "-"}`);
  } catch {
    console.log(chalk.red("Not found"));
  }
});

agent.command("create").description("Create a new agent").argument("<name>")
  .option("--global", "Save to ~/.ark/agents/ instead of project")
  .action(async (name, opts) => {
    const projectRoot = core.findProjectRoot(process.cwd());
    const scope: "project" | "global" = opts.global || !projectRoot ? "global" : "project";
    const dir = scope === "project" ? join(projectRoot!, ".ark", "agents") : join(core.ARK_DIR(), "agents");
    const filePath = join(dir, `${name}.yaml`);

    if (existsSync(filePath)) {
      console.log(chalk.red(`Agent '${name}' already exists at ${filePath}`));
      return;
    }

    mkdirSync(dir, { recursive: true });
    const scaffold = YAML.stringify({
      name,
      description: "",
      model: "sonnet",
      max_turns: 200,
      system_prompt: "",
      tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
      mcp_servers: [],
      skills: [],
      memories: [],
      context: [],
      permission_mode: "bypassPermissions",
      env: {},
    });
    writeFileSync(filePath, scaffold);
    console.log(chalk.green(`Created ${scope} agent: ${filePath}`));

    const editor = process.env.EDITOR || "vi";
    execFileSync(editor, [filePath], { stdio: "inherit" });
  });

agent.command("edit").description("Edit an agent definition").argument("<name>").action(async (name) => {
  const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;
  const a = core.loadAgent(name, projectRoot);
  if (!a) { console.log(chalk.red(`Agent '${name}' not found`)); return; }

  if (a._source === "builtin") {
    const readline = await import("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => rl.question(
      `'${name}' is a builtin agent. Copy to [p]roject/[g]lobal first? [p/g/N] `, resolve,
    ));
    rl.close();
    const choice = answer.trim().toLowerCase();
    if (choice === "p" && projectRoot) {
      core.saveAgent(a, "project", projectRoot);
      const path = join(projectRoot, ".ark", "agents", `${name}.yaml`);
      execFileSync(process.env.EDITOR || "vi", [path], { stdio: "inherit" });
    } else if (choice === "g") {
      core.saveAgent(a, "global");
      const path = join(core.ARK_DIR(), "agents", `${name}.yaml`);
      execFileSync(process.env.EDITOR || "vi", [path], { stdio: "inherit" });
    } else {
      console.log("Cancelled.");
    }
    return;
  }

  execFileSync(process.env.EDITOR || "vi", [a._path!], { stdio: "inherit" });
});

agent.command("delete").description("Delete a custom agent").argument("<name>").action(async (name) => {
  const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;
  const a = core.loadAgent(name, projectRoot);
  if (!a) { console.log(chalk.red(`Agent '${name}' not found`)); return; }

  if (a._source === "builtin") {
    console.log(chalk.red("Cannot delete builtin agents."));
    return;
  }

  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => rl.question(
    `Delete ${a._source} agent '${name}' at ${a._path}? [y/N] `, resolve,
  ));
  rl.close();

  if (answer.trim().toLowerCase() === "y") {
    const scope = a._source as "project" | "global";
    core.deleteAgent(name, scope, scope === "project" ? projectRoot : undefined);
    console.log(chalk.green(`Deleted '${name}'.`));
  } else {
    console.log("Cancelled.");
  }
});

agent.command("copy").description("Copy an agent for customization").argument("<name>").argument("[new-name]")
  .option("--global", "Save to ~/.ark/agents/ instead of project")
  .action((name, newName, opts) => {
    const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;
    const a = core.loadAgent(name, projectRoot);
    if (!a) { console.log(chalk.red(`Agent '${name}' not found`)); return; }

    const targetName = newName || name;
    const scope: "project" | "global" = opts.global || !projectRoot ? "global" : "project";
    const copy = { ...a, name: targetName };
    core.saveAgent(copy, scope, scope === "project" ? projectRoot : undefined);

    const dir = scope === "project" ? join(projectRoot!, ".ark", "agents") : join(core.ARK_DIR(), "agents");
    console.log(chalk.green(`Copied '${name}' → ${scope} '${targetName}' at ${join(dir, `${targetName}.yaml`)}`));
  });

// ── Flow commands ───────────────────────────────────────────────────────────

const pipe = program.command("flow").description("Manage flows");

pipe.command("list").description("List flows").action(async () => {
  const ark = await getArkClient();
  const flows = await ark.flowList();
  for (const p of flows) {
    console.log(`  ${p.name.padEnd(16)} ${p.stages.join(" > ")}  ${chalk.dim(p.description.slice(0, 40))}`);
  }
});

pipe.command("show").description("Show flow").argument("<name>").action(async (name) => {
  const ark = await getArkClient();
  try {
    const p = await ark.flowRead(name);
    console.log(chalk.bold(`\n${p.name}`));
    if (p.description) console.log(chalk.dim(`  ${p.description}`));
    for (const [i, s] of p.stages.entries()) {
      const type = s.type ?? (s.action ? "action" : "agent");
      const detail = s.agent ?? s.action ?? "";
      console.log(`  ${i + 1}. ${s.name.padEnd(14)} [${type}:${detail}] gate=${s.gate}${s.optional ? " (optional)" : ""}`);
    }
  } catch {
    console.log(chalk.red("Not found"));
  }
});

// ── Skill commands ──────────────────────────────────────────────────────────

const skillCmd = program.command("skill").description("Manage skills");

skillCmd.command("list")
  .description("List available skills")
  .action(async () => {
    const ark = await getArkClient();
    const skills = await ark.skillList();
    if (!skills.length) {
      console.log(chalk.dim("No skills found."));
      return;
    }
    for (const s of skills) {
      console.log(`  ${(s._source ?? "").padEnd(8)} ${s.name.padEnd(20)} ${s.description}`);
    }
  });

skillCmd.command("show")
  .description("Show skill details")
  .argument("<name>", "Skill name")
  .action(async (name: string) => {
    const ark = await getArkClient();
    const skill = await ark.skillRead(name);
    if (!skill) { console.log(chalk.red(`Skill not found: ${name}`)); return; }
    console.log(chalk.bold(`\n${skill.name}`) + chalk.dim(` (${skill._source})`));
    console.log(`  Description: ${skill.description}`);
    if (skill.tags?.length) console.log(`  Tags:        ${skill.tags.join(", ")}`);
    if (skill.prompt) {
      console.log(`\n${chalk.bold("Prompt:")}`);
      console.log(skill.prompt);
    }
  });

skillCmd.command("create")
  .description("Create a new skill")
  .argument("[name]", "Skill name (required unless --from)")
  .option("--from <file>", "Create from YAML file")
  .option("-d, --description <desc>", "Skill description")
  .option("-p, --prompt <prompt>", "Skill prompt")
  .option("-s, --scope <scope>", "Scope: global or project", "global")
  .option("--tags <tags>", "Comma-separated tags")
  .action((name: string | undefined, opts: any) => {
    const scope = opts.scope as "global" | "project";
    const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;

    if (opts.from) {
      let content: string;
      try { content = readFileSync(opts.from, "utf-8"); }
      catch { console.error(chalk.red(`Cannot read file: ${opts.from}`)); process.exit(1); }
      const skill = YAML.parse(content);
      if (!skill.name) { console.error(chalk.red("YAML must have a 'name' field")); process.exit(1); }
      core.saveSkill(skill, scope, projectRoot);
      console.log(chalk.green(`Created skill: ${skill.name} (${scope})`));
      return;
    }

    if (!name) { console.error(chalk.red("Name required (or use --from)")); process.exit(1); }
    if (!opts.prompt) { console.error(chalk.red("--prompt required")); process.exit(1); }

    core.saveSkill({
      name,
      description: opts.description ?? "",
      prompt: opts.prompt,
      tags: opts.tags?.split(",").map((t: string) => t.trim()) ?? [],
    }, scope, projectRoot);
    console.log(chalk.green(`Created skill: ${name} (${scope})`));
  });

skillCmd.command("delete")
  .description("Delete a skill (global or project only)")
  .argument("<name>", "Skill name")
  .option("-s, --scope <scope>", "Scope: global or project", "global")
  .action((name: string, opts: any) => {
    const scope = opts.scope as "global" | "project";
    const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;

    const skill = core.loadSkill(name, projectRoot);
    if (skill && skill._source === "builtin") {
      console.error(chalk.red(`Cannot delete builtin skill: ${name}`));
      process.exit(1);
    }
    if (!skill) {
      console.error(chalk.red(`Skill not found: ${name}`));
      process.exit(1);
    }

    core.deleteSkill(name, scope, projectRoot);
    console.log(chalk.green(`Deleted skill: ${name}`));
  });

// ── Recipe commands ─────────────────────────────────────────────────────────

const recipeCmd = program.command("recipe").description("Manage recipes");

recipeCmd.command("list")
  .description("List available recipes")
  .action(async () => {
    const ark = await getArkClient();
    const recipes = await ark.recipeList();
    if (!recipes.length) {
      console.log(chalk.dim("No recipes found."));
      return;
    }
    for (const r of recipes) {
      console.log(`  ${(r._source ?? "").padEnd(8)} ${r.name.padEnd(20)} ${r.description}`);
    }
  });

recipeCmd.command("show")
  .description("Show recipe details")
  .argument("<name>", "Recipe name")
  .action(async (name: string) => {
    const ark = await getArkClient();
    try {
      const recipe = await ark.recipeRead(name);
      if (!recipe) { console.log(chalk.red(`Recipe not found: ${name}`)); return; }
      console.log(chalk.bold(`\n${recipe.name}`) + chalk.dim(` (${recipe._source})`));
      console.log(`  Description: ${recipe.description}`);
      console.log(`  Flow:        ${recipe.flow}`);
      if (recipe.agent) console.log(`  Agent:       ${recipe.agent}`);
      if (recipe.variables?.length) {
        console.log(chalk.bold(`\n  Variables:`));
        for (const v of recipe.variables) {
          console.log(`    ${v.name}${v.required ? " *" : ""}  ${v.description}${v.default ? ` (default: ${v.default})` : ""}`);
        }
      }
    } catch {
      console.log(chalk.red(`Recipe not found: ${name}`));
    }
  });

recipeCmd.command("create")
  .description("Create a new recipe")
  .option("--from <file>", "Create from YAML file")
  .option("--from-session <id>", "Create from existing session")
  .option("-n, --name <name>", "Recipe name (required with --from-session)")
  .option("-s, --scope <scope>", "Scope: global or project", "global")
  .action(async (opts: any) => {
    const scope = opts.scope as "global" | "project";
    const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;

    if (opts.fromSession) {
      if (!opts.name) { console.error(chalk.red("--name required with --from-session")); process.exit(1); }
      const ark = await getArkClient();
      const { session } = await ark.sessionRead(opts.fromSession);
      if (!session) { console.error(chalk.red(`Session not found: ${opts.fromSession}`)); process.exit(1); }
      const recipe = core.sessionToRecipe(session, opts.name);
      core.saveRecipe(recipe, scope, projectRoot);
      console.log(chalk.green(`Created recipe: ${opts.name} from session ${opts.fromSession} (${scope})`));
      return;
    }

    if (opts.from) {
      let content: string;
      try { content = readFileSync(opts.from, "utf-8"); }
      catch { console.error(chalk.red(`Cannot read file: ${opts.from}`)); process.exit(1); }
      const recipe = YAML.parse(content);
      if (!recipe.name) { console.error(chalk.red("YAML must have a 'name' field")); process.exit(1); }
      core.saveRecipe(recipe, scope, projectRoot);
      console.log(chalk.green(`Created recipe: ${recipe.name} (${scope})`));
      return;
    }

    console.error(chalk.red("Must specify --from <file> or --from-session <id>"));
    process.exit(1);
  });

recipeCmd.command("delete")
  .description("Delete a recipe (global or project only)")
  .argument("<name>", "Recipe name")
  .option("-s, --scope <scope>", "Scope: global or project", "global")
  .action((name: string, opts: any) => {
    const scope = opts.scope as "global" | "project";
    const projectRoot = core.findProjectRoot(process.cwd()) ?? undefined;

    const recipe = core.loadRecipe(name, projectRoot);
    if (recipe && recipe._source === "builtin") {
      console.error(chalk.red(`Cannot delete builtin recipe: ${name}`));
      process.exit(1);
    }
    if (!recipe) {
      console.error(chalk.red(`Recipe not found: ${name}`));
      process.exit(1);
    }

    core.deleteRecipe(name, scope, projectRoot);
    console.log(chalk.green(`Deleted recipe: ${name}`));
  });

// ── Memory commands ────────────────────────────────────────────────────────

const memoryCmd = program.command("memory").description("Manage cross-session memory");

memoryCmd.command("list")
  .description("List stored memories")
  .option("-s, --scope <scope>", "Filter by scope")
  .action(async (opts) => {
    const ark = await getArkClient();
    const memories = await ark.memoryList(opts.scope);
    if (!memories.length) {
      console.log(chalk.dim("No memories stored."));
      return;
    }
    for (const m of memories) {
      const tags = m.tags.length ? chalk.dim(` [${m.tags.join(", ")}]`) : "";
      const scope = chalk.dim(`(${m.scope})`);
      console.log(`  ${m.id}  ${scope} ${m.content.slice(0, 60)}${m.content.length > 60 ? "..." : ""}${tags}`);
    }
    console.log(chalk.dim(`\n${memories.length} memories total`));
  });

memoryCmd.command("recall")
  .description("Recall memories relevant to a query")
  .argument("<query>", "Search query")
  .option("-s, --scope <scope>", "Filter by scope")
  .option("-n, --limit <n>", "Max results", "10")
  .action(async (query: string, opts) => {
    const ark = await getArkClient();
    const results = await ark.memoryRecall(query, { scope: opts.scope, limit: Number(opts.limit) });
    if (!results.length) {
      console.log(chalk.dim("No relevant memories found."));
      return;
    }
    for (const m of results) {
      const tags = m.tags.length ? chalk.dim(` [${m.tags.join(", ")}]`) : "";
      console.log(`  ${chalk.bold(m.id)}  ${m.content.slice(0, 80)}${m.content.length > 80 ? "..." : ""}${tags}`);
    }
  });

memoryCmd.command("forget")
  .description("Forget a specific memory")
  .argument("<id>", "Memory ID")
  .action(async (id: string) => {
    const ark = await getArkClient();
    const ok = await ark.memoryForget(id);
    console.log(ok ? chalk.green(`Forgot ${id}`) : chalk.red(`Memory ${id} not found`));
  });

memoryCmd.command("add")
  .description("Store a new memory")
  .argument("<content>", "Memory content")
  .option("-t, --tags <tags>", "Comma-separated tags")
  .option("-s, --scope <scope>", "Scope (default: global)")
  .option("-i, --importance <n>", "Importance 0-1 (default: 0.5)")
  .action(async (content: string, opts: any) => {
    const ark = await getArkClient();
    const memory = await ark.memoryAdd(content, {
      tags: opts.tags ? opts.tags.split(",").map((t: string) => t.trim()) : undefined,
      scope: opts.scope,
      importance: opts.importance ? parseFloat(opts.importance) : undefined,
    });
    console.log(chalk.green(`Remembered: ${memory.id}`));
    if (memory.tags.length) console.log(chalk.dim(`Tags: ${memory.tags.join(", ")}`));
  });

memoryCmd.command("clear")
  .description("Clear all memories in a scope")
  .option("-s, --scope <scope>", "Scope to clear (omit for ALL)")
  .option("--force", "Skip confirmation")
  .action(async (opts: any) => {
    const ark = await getArkClient();
    if (!opts.force) {
      const label = opts.scope ? `scope '${opts.scope}'` : "ALL memories";
      console.log(chalk.yellow(`This will delete ${label}. Use --force to confirm.`));
      return;
    }
    const count = await ark.memoryClear(opts.scope);
    console.log(chalk.green(`Cleared ${count} memories`));
  });

// ── Knowledge commands ─────────────────────────────────────────────────────

const knowledgeCmd = program.command("knowledge").description("Knowledge ingestion");

knowledgeCmd.command("ingest")
  .description("Ingest files into the knowledge base")
  .argument("<path>", "File or directory to ingest")
  .option("-s, --scope <scope>", "Scope for ingested knowledge", "knowledge")
  .option("-t, --tag <tag>", "Tag (repeatable)", (val: string, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
  .action((path: string, opts) => {
    const resolved = resolve(path);
    if (!existsSync(resolved)) {
      console.log(chalk.red(`Path not found: ${resolved}`));
      return;
    }
    const stat = require("fs").statSync(resolved);
    if (stat.isDirectory()) {
      const result = core.ingestDirectory(resolved, { scope: opts.scope, tags: opts.tag });
      console.log(chalk.green(`Ingested ${result.files} files (${result.chunks} chunks) from ${resolved}`));
    } else {
      const chunks = core.ingestFile(resolved, { scope: opts.scope, tags: opts.tag });
      console.log(chunks > 0
        ? chalk.green(`Ingested ${resolved} (${chunks} chunks)`)
        : chalk.yellow(`Skipped ${resolved} (unsupported or empty)`));
    }
  });

// ── Compute commands ────────────────────────────────────────────────────────

const computeCmd = program.command("compute").description("Manage compute resources");

computeCmd.command("create")
  .description("Create a new compute resource")
  .argument("<name>", "Compute name")
  .option("--provider <type>", "Provider type", "local")
  // EC2-specific options
  .option("--size <size>", "Instance size: xs (2vCPU/8GB), s (4/16), m (8/32), l (16/64), xl (32/128), xxl (48/192), xxxl (64/256)", "m")
  .option("--arch <arch>", "Architecture: x64, arm", "x64")
  .option("--region <region>", "Region", "us-east-1")
  .option("--profile <profile>", "AWS profile")
  .option("--subnet-id <id>", "Subnet ID")
  .option("--tag <key=value>", "Tag (repeatable)", (val: string, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
  // Docker-specific options
  .option("--image <image>", "Docker image (default: ubuntu:22.04)")
  .option("--devcontainer", "Use devcontainer.json from project")
  .option("--volume <mount>", "Extra volume mount (repeatable)", (val: string, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
  .action(async (name, opts) => {
    if (opts.provider === "local") {
      console.log(chalk.red("Local compute is auto-created. Use 'ec2' or 'docker' provider."));
      return;
    }
    try {
      const ark = await getArkClient();
      let config: Record<string, unknown>;

      if (opts.provider === "docker") {
        config = {
          image: opts.image ?? "ubuntu:22.04",
          ...(opts.devcontainer ? { devcontainer: true } : {}),
          ...(opts.volume?.length ? { volumes: opts.volume } : {}),
        };
      } else if (opts.provider === "ec2") {
        const tags: Record<string, string> = {};
        for (const t of opts.tag) {
          const [k, ...rest] = t.split("=");
          if (k && rest.length) tags[k] = rest.join("=");
        }
        config = {
          size: opts.size,
          arch: opts.arch,
          region: opts.region,
          ...(opts.profile ? { aws_profile: opts.profile } : {}),
          ...(opts.subnetId ? { subnet_id: opts.subnetId } : {}),
          ...(Object.keys(tags).length ? { tags } : {}),
        };
      } else {
        config = {};
      }

      const compute = await ark.computeCreate({
        name,
        provider: opts.provider,
        config,
      });

      console.log(chalk.green(`Compute '${compute.name}' created`));
      console.log(`  Provider: ${compute.provider}`);
      console.log(`  Status:   ${compute.status}`);

      if (opts.provider === "docker") {
        console.log(`  Image:    ${(config.image as string) ?? "ubuntu:22.04"}`);
        if (config.devcontainer) console.log(`  Devcontainer: yes`);
        if ((config.volumes as string[] | undefined)?.length) {
          console.log(`  Volumes:  ${(config.volumes as string[]).join(", ")}`);
        }
      } else if (opts.provider === "ec2") {
        let sizeLabel = opts.size;
        try {
          const { INSTANCE_SIZES } = require("../compute/providers/ec2/provision.js");
          const tier = INSTANCE_SIZES[opts.size];
          if (tier) sizeLabel = tier.label;
        } catch { /* not ec2 provider */ }
        console.log(`  Size:     ${sizeLabel}`);
        console.log(`  Arch:     ${opts.arch}`);
        console.log(`  Region:   ${opts.region}`);
      }
    } catch (e: any) {
      console.log(chalk.red(`Failed to create compute: ${e.message}`));
    }
  });

computeCmd.command("provision")
  .description("Provision a compute resource (create infrastructure)")
  .argument("<name>", "Compute name")
  .action(async (name) => {
    const ark = await getArkClient();
    try {
      const compute = await ark.computeRead(name);
      console.log(chalk.dim(`Provisioning '${name}' via ${compute.provider}...`));
      await ark.computeProvision(name);
      console.log(chalk.green(`Compute '${name}' provisioned and running`));
    } catch (e: any) {
      try { await ark.computeUpdate(name, { status: "stopped" }); } catch { /* ignore */ }
      console.log(chalk.red(`Provision failed: ${e.message}`));
    }
  });

computeCmd.command("start")
  .description("Start a compute resource")
  .argument("<name>", "Compute name")
  .action(async (name) => {
    const ark = await getArkClient();
    try {
      await ark.computeStartInstance(name);
      console.log(chalk.green(`Compute '${name}' started`));
    } catch (e: any) {
      console.log(chalk.red(`Start failed: ${e.message}`));
    }
  });

computeCmd.command("stop")
  .description("Stop a compute resource")
  .argument("<name>", "Compute name")
  .action(async (name) => {
    const ark = await getArkClient();
    try {
      await ark.computeStopInstance(name);
      console.log(chalk.yellow(`Compute '${name}' stopped`));
    } catch (e: any) {
      console.log(chalk.red(`Stop failed: ${e.message}`));
    }
  });

computeCmd.command("destroy")
  .description("Destroy a compute resource (remove infrastructure)")
  .argument("<name>", "Compute name")
  .action(async (name) => {
    const ark = await getArkClient();
    try {
      await ark.computeDestroy(name);
      console.log(chalk.green(`Compute '${name}' destroyed`));
    } catch (e: any) {
      console.log(chalk.red(`Destroy failed: ${e.message}`));
    }
  });

computeCmd.command("delete")
  .description("Delete a compute record from the database")
  .argument("<name>", "Compute name")
  .action(async (name) => {
    const ark = await getArkClient();
    try {
      const compute = await ark.computeRead(name);
      if (compute.status === "running") {
        console.log(chalk.red("Compute is running. Stop or destroy it first."));
        return;
      }
      await ark.computeDelete(name);
      console.log(chalk.green(`Compute '${name}' deleted`));
    } catch (e: any) {
      console.log(chalk.red(`Compute '${name}' not found`));
    }
  });

computeCmd.command("update")
  .description("Update compute configuration")
  .argument("<name>", "Compute name")
  .option("--size <size>", "Instance size")
  .option("--arch <arch>", "Architecture: x64, arm")
  .option("--region <region>", "AWS region")
  .option("--profile <profile>", "AWS profile")
  .option("--subnet-id <id>", "Subnet ID")
  .option("--ingress <cidrs>", "SSH ingress CIDRs (comma-separated, or 'open' for 0.0.0.0/0)")
  .option("--idle-minutes <min>", "Idle shutdown timeout in minutes")
  .option("--set <key=value>", "Set arbitrary config key", (val: string, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
  .action(async (name, opts) => {
    const ark = await getArkClient();
    try {
      const compute = await ark.computeRead(name);

      const config = { ...compute.config } as any;
      if (opts.size) config.size = opts.size;
      if (opts.arch) config.arch = opts.arch;
      if (opts.region) config.region = opts.region;
      if (opts.profile) config.aws_profile = opts.profile;
      if (opts.subnetId) config.subnet_id = opts.subnetId;
      if (opts.ingress) {
        config.ingress_cidrs = opts.ingress === "open"
          ? ["0.0.0.0/0"]
          : opts.ingress.split(",").map((s: string) => s.trim());
      }
      if (opts.idleMinutes) config.idle_minutes = parseInt(opts.idleMinutes);
      for (const kv of opts.set) {
        const [k, ...rest] = kv.split("=");
        if (k && rest.length) config[k] = rest.join("=");
      }

      await ark.computeUpdate(name, { config });
      console.log(chalk.green(`Compute '${name}' updated`));
      console.log(JSON.stringify(config, null, 2));
    } catch (e: any) {
      console.log(chalk.red(`Compute '${name}' not found`));
    }
  });

computeCmd.command("list")
  .description("List all compute")
  .action(async () => {
    const ark = await getArkClient();
    const computes = await ark.computeList();
    if (!computes.length) {
      console.log(chalk.dim("No compute. Create one: ark compute create <name> --provider local"));
      return;
    }
    console.log(`  ${"NAME".padEnd(20)} ${"PROVIDER".padEnd(10)} ${"STATUS".padEnd(14)} IP`);
    for (const h of computes) {
      const ip = (h.config as any).ip ?? "-";
      console.log(`  ${h.name.padEnd(20)} ${h.provider.padEnd(10)} ${h.status.padEnd(14)} ${ip}`);
    }
  });

computeCmd.command("status")
  .description("Show compute details")
  .argument("<name>", "Compute name")
  .action(async (name) => {
    const ark = await getArkClient();
    try {
      const compute = await ark.computeRead(name);
      console.log(JSON.stringify(compute, null, 2));
      if (compute.status === "running") {
        try {
          const snap = await ark.metricsSnapshot(name);
          console.log(chalk.bold("\nMetrics:"));
          console.log(`  CPU:  ${snap.metrics.cpu.toFixed(1)}%`);
          console.log(`  MEM:  ${snap.metrics.memUsedGb.toFixed(1)}/${snap.metrics.memTotalGb.toFixed(1)} GB (${snap.metrics.memPct.toFixed(1)}%)`);
          console.log(`  DISK: ${snap.metrics.diskPct.toFixed(1)}%`);
        } catch (e: any) {
          console.log(chalk.dim(`(metrics unavailable: ${e.message})`));
        }
      }
    } catch (e: any) {
      console.log(chalk.red(`Compute '${name}' not found`));
    }
  });

computeCmd.command("sync")
  .description("Sync environment to/from compute")
  .argument("<name>", "Compute name")
  .option("--direction <dir>", "Sync direction (push|pull)", "push")
  .action(async (name, opts) => {
    const ark = await getArkClient();
    let compute: any;
    try { compute = await ark.computeRead(name); } catch { console.log(chalk.red(`Compute '${name}' not found`)); return; }
    const provider = getProvider(compute.provider);
    if (!provider) { console.log(chalk.red(`Provider '${compute.provider}' not found`)); return; }
    try {
      console.log(chalk.dim(`Syncing (${opts.direction}) to '${name}'...`));
      await provider.syncEnvironment(compute, { direction: opts.direction });
      console.log(chalk.green(`Sync complete (${opts.direction})`));
    } catch (e: any) {
      console.log(chalk.red(`Sync failed: ${e.message}`));
    }
  });

computeCmd.command("metrics")
  .description("Show compute metrics")
  .argument("<name>", "Compute name")
  .action(async (name) => {
    const ark = await getArkClient();
    try {
      const snap = await ark.metricsSnapshot(name);
      if (!snap) { console.log(chalk.red(`No metrics for '${name}'`)); return; }
      console.log(chalk.bold(`\nCompute: ${name}`));
      console.log(`  CPU:       ${snap.metrics.cpu.toFixed(1)}%`);
      console.log(`  MEM:       ${snap.metrics.memUsedGb.toFixed(1)}/${snap.metrics.memTotalGb.toFixed(1)} GB (${snap.metrics.memPct.toFixed(1)}%)`);
      console.log(`  DISK:      ${snap.metrics.diskPct.toFixed(1)}%`);
      console.log(`  NET:       rx=${snap.metrics.netRxMb.toFixed(1)} MB  tx=${snap.metrics.netTxMb.toFixed(1)} MB`);
      console.log(`  Uptime:    ${snap.metrics.uptime}`);
      console.log(`  Sessions:  ${snap.sessions.length}`);
      console.log(`  Processes: ${snap.processes.length}`);
    } catch (e: any) {
      console.log(chalk.red(`Metrics failed: ${e.message}`));
    }
  });

computeCmd.command("default")
  .description("Set default compute")
  .argument("<name>", "Compute name")
  .action(async (name) => {
    const ark = await getArkClient();
    try { await ark.computeRead(name); } catch { console.log(chalk.red(`Compute '${name}' not found`)); return; }
    const envPath = join(homedir(), ".ark", ".env");
    mkdirSync(dirname(envPath), { recursive: true });
    // Read existing, update or append
    let content = "";
    try { content = readFileSync(envPath, "utf-8"); } catch { /* new file */ }
    if (content.includes("ARK_DEFAULT_COMPUTE=")) {
      content = content.replace(/ARK_DEFAULT_COMPUTE=.*/g, `ARK_DEFAULT_COMPUTE=${name}`);
    } else {
      content += `\nARK_DEFAULT_COMPUTE=${name}\n`;
    }
    writeFileSync(envPath, content.trimStart());
    process.env.ARK_DEFAULT_COMPUTE = name;
    console.log(chalk.green(`Default compute set to '${name}'`));
  });

computeCmd.command("ssh")
  .description("SSH into a compute")
  .argument("<name>", "Compute name")
  .action(async (name) => {
    const ark = await getArkClient();
    let compute: any;
    try { compute = await ark.computeRead(name); } catch { console.log(chalk.red(`Compute '${name}' not found`)); return; }
    const ip = (compute.config as any).ip;
    const keyPath = (compute.config as any).key_path;
    const user = (compute.config as any).ssh_user ?? "ubuntu";
    if (!ip) { console.log(chalk.red(`Compute '${name}' has no IP address`)); return; }
    const sshArgs = [`${user}@${ip}`];
    if (keyPath) sshArgs.unshift("-i", keyPath);
    console.log(chalk.dim(`$ ssh ${sshArgs.join(" ")}`));
    try {
      require("child_process").execFileSync("ssh", sshArgs, { stdio: "inherit" });
    } catch (e: any) {
      console.log(chalk.red(`SSH failed: ${e.message}`));
    }
  });

// ── Worktree commands ──────────────────────────────────────────────────────

const worktree = program.command("worktree").description("Git worktree operations");

worktree.command("finish")
  .description("Merge worktree branch, remove worktree, delete session")
  .argument("<session-id>")
  .option("--into <branch>", "Target branch to merge into", "main")
  .option("--no-merge", "Skip merge, just remove worktree and delete session")
  .option("--keep-branch", "Don't delete the branch after merge")
  .action(async (sessionId: string, opts: any) => {
    const ark = await getArkClient();
    const result = await ark.worktreeFinish(sessionId, { noMerge: opts.noMerge });
    console.log(result.ok ? chalk.green(result.message) : chalk.red(result.message));
  });

worktree.command("list")
  .description("List sessions with active worktrees")
  .action(async () => {
    const ark = await getArkClient();
    const sessions = await ark.sessionList({ limit: 500 });
    const withWorktrees = sessions.filter(s => {
      const wtDir = join(core.WORKTREES_DIR(), s.id);
      return existsSync(wtDir);
    });

    if (withWorktrees.length === 0) {
      console.log(chalk.dim("No sessions with active worktrees"));
      return;
    }

    for (const s of withWorktrees) {
      const branch = s.branch ?? "?";
      const status = s.status;
      console.log(`${s.id}  ${chalk.cyan(branch.padEnd(30))}  ${status.padEnd(10)}  ${s.summary ?? ""}`);
    }
  });

worktree.command("cleanup")
  .description("Find and remove orphaned worktrees")
  .option("--dry-run", "Only show what would be removed")
  .action(async (opts) => {
    const orphans = core.findOrphanedWorktrees();
    if (orphans.length === 0) {
      console.log(chalk.dim("No orphaned worktrees found"));
      return;
    }
    console.log(chalk.yellow(`Found ${orphans.length} orphaned worktrees:`));
    for (const id of orphans) console.log(`  ${id}`);
    if (opts.dryRun) return;
    const result = await core.cleanupWorktrees();
    console.log(chalk.green(`Removed: ${result.removed}`));
    if (result.errors.length) {
      console.log(chalk.red(`Errors: ${result.errors.length}`));
      for (const e of result.errors) console.log(chalk.dim(`  ${e}`));
    }
  });

// ── Claude session discovery ────────────────────────────────────────────────

const claudeCmd = program.command("claude").description("Interact with Claude Code sessions");

claudeCmd.command("list")
  .description("List Claude Code sessions found on disk")
  .option("-p, --project <filter>", "Filter by project path")
  .option("-l, --limit <n>", "Max results", "20")
  .action(async (opts) => {
    const ark = await getArkClient();
    const sessions = await ark.historyList(parseInt(opts.limit));

    if (sessions.length === 0) {
      console.log(chalk.yellow("No Claude sessions found."));
      return;
    }

    console.log(chalk.bold(`Found ${sessions.length} Claude session(s):\n`));
    for (const s of sessions) {
      const date = (s.lastActivity || s.timestamp || "").slice(0, 10);
      const msgs = chalk.dim(`${s.messageCount} msgs`);
      const proj = chalk.cyan(s.project.split("/").slice(-2).join("/"));
      const summary = s.summary ? s.summary.slice(0, 80) : chalk.dim("(no summary)");
      console.log(`  ${chalk.dim(s.sessionId.slice(0, 8))}  ${date}  ${proj}  ${msgs}  ${summary}`);
    }
    console.log(chalk.dim(`\nUse: ark session start --claude-session <id> --flow bare`));
  });

// ── TUI command ─────────────────────────────────────────────────────────────

program.command("tui").description("Launch TUI dashboard").action(async () => {
  await import("../tui/index.js");
});

// ── Conductor command ────────────────────────────────────────────────────────

const conductorCmd = program.command("conductor").description("Conductor operations");

conductorCmd.command("start")
  .description("Start the conductor server")
  .option("-p, --port <port>", "Port", "19100")
  .action(async (opts) => {
    const { startConductor } = await import("../core/conductor.js");
    startConductor(parseInt(opts.port));
    // Keep alive
    setInterval(() => {}, 60_000);
  });

conductorCmd.command("learnings")
  .description("Show conductor learnings and policies")
  .action(async () => {
    const core = await import("../core/index.js");
    const dir = core.conductorLearningsDir(core.ARK_DIR());
    const learnings = core.getLearnings(dir);
    const policies = core.getPolicies(dir);

    if (policies.length > 0) {
      console.log(chalk.bold("\nPolicies (promoted from learnings):\n"));
      for (const p of policies) {
        console.log(`  ${chalk.green("\u2713")} ${chalk.bold(p.title)}`);
        if (p.description) console.log(`    ${chalk.dim(p.description.split("\n")[0])}`);
      }
    }

    if (learnings.length > 0) {
      console.log(chalk.bold("\nActive learnings:\n"));
      for (const l of learnings) {
        const bar = "\u2588".repeat(l.recurrence) + "\u2591".repeat(3 - l.recurrence);
        console.log(`  ${bar} ${chalk.bold(l.title)} (seen ${l.recurrence}x)`);
        if (l.description) console.log(`    ${chalk.dim(l.description.split("\n")[0])}`);
      }
    }

    if (learnings.length === 0 && policies.length === 0) {
      console.log(chalk.dim("No learnings yet. The conductor records patterns during orchestration."));
    }
  });

conductorCmd.command("learn")
  .description("Record a conductor learning")
  .argument("<title>")
  .argument("[description]")
  .action(async (title, description) => {
    const core = await import("../core/index.js");
    const dir = core.conductorLearningsDir(core.ARK_DIR());
    const result = core.recordLearning(dir, title, description ?? "");
    if (result.promoted) {
      console.log(chalk.green(`Promoted to policy: ${title} (recurrence: ${result.learning.recurrence})`));
    } else {
      console.log(chalk.blue(`Recorded: ${title} (recurrence: ${result.learning.recurrence}/3)`));
    }
  });

conductorCmd.command("bridge")
  .description("Start the messaging bridge (Telegram/Slack)")
  .action(async () => {
    const bridge = core.createBridge();
    if (!bridge) {
      console.log(chalk.red("No bridge config found. Create ~/.ark/bridge.json with telegram/slack settings."));
      console.log(chalk.dim("\nExample ~/.ark/bridge.json:"));
      console.log(chalk.dim(JSON.stringify({
        telegram: { botToken: "123:ABC...", chatId: "12345" },
        slack: { webhookUrl: "https://hooks.slack.com/services/..." },
      }, null, 2)));
      return;
    }

    // Handle common commands
    bridge.onMessage(async (msg) => {
      const text = msg.text.trim().toLowerCase();
      if (text === "/status" || text === "status") {
        await bridge.notifyStatusSummary();
      } else if (text === "/sessions" || text === "sessions") {
        const sessions = core.listSessions({ limit: 20 });
        const lines = sessions.map(s => `\u2022 ${s.summary ?? s.id} (${s.status})`);
        await bridge.notify(lines.join("\n") || "No sessions");
      } else {
        await bridge.notify(`Unknown command: ${text}`);
      }
    });

    console.log(chalk.green("Bridge started. Ctrl+C to stop."));

    // Keep alive
    await new Promise(() => {});
  });

conductorCmd.command("notify")
  .description("Send a test notification via bridge")
  .argument("<message>")
  .action(async (message) => {
    const bridge = core.createBridge();
    if (!bridge) {
      console.log(chalk.red("No bridge config. Create ~/.ark/bridge.json"));
      return;
    }
    await bridge.notify(message);
    bridge.stop();
    console.log(chalk.green("Notification sent"));
  });

// ── ArkD (universal agent daemon) ────────────────────────────────────────────

program.command("arkd")
  .description("Start the arkd agent daemon")
  .option("-p, --port <port>", "Port", "19300")
  .option("--conductor-url <url>", "Conductor URL for channel relay")
  .action(async (opts) => {
    const { startArkd } = await import("../arkd/index.js");
    const conductorUrl = opts.conductorUrl || process.env.ARK_CONDUCTOR_URL || "http://localhost:19100";
    startArkd(parseInt(opts.port), { conductorUrl });
    // Keep alive
    setInterval(() => {}, 60_000);
  });

// ── Channel (MCP stdio server for remote compute) ──────────────────────────

program.command("channel")
  .description("Run the MCP channel server (used by remote agents)")
  .action(async () => {
    await import("../core/channel.js");
  });

// ── Auth ────────────────────────────────────────────────────────────────────

program.command("auth")
  .description("Set up Claude authentication (local + sync to remote hosts)")
  .option("--host <name>", "Run setup-token on a specific remote host instead")
  .action(async (opts) => {
    const { execFileSync } = await import("child_process");
    if (opts.host) {
      const ark = await getArkClient();
      let compute: any;
      try { compute = await ark.computeRead(opts.host); } catch { console.error(`Compute '${opts.host}' not found`); process.exit(1); }
      const cfg = compute.config as any;
      if (!cfg.ip) { console.error(`No IP for '${opts.host}'`); process.exit(1); }
      const key = `${process.env.HOME}/.ssh/ark-${compute.name}`;
      console.log(`Running setup-token on ${compute.name} (${cfg.ip})...`);
      execFileSync("ssh", [
        "-i", key, "-o", "StrictHostKeyChecking=no", "-t",
        `ubuntu@${cfg.ip}`, "~/.local/bin/claude setup-token",
      ], { stdio: "inherit" });
    } else {
      const { writeFileSync, mkdirSync } = await import("fs");
      const { join } = await import("path");
      const { spawn } = await import("child_process");

      console.log("Setting up Claude authentication...\n");

      // Spawn setup-token as a child process that forwards signals
      const exitCode = await new Promise<number>((resolve) => {
        const child = spawn("claude", ["setup-token"], {
          stdio: "inherit",
        });
        // Forward Ctrl+C to the child
        process.on("SIGINT", () => child.kill("SIGINT"));
        child.on("close", (code) => resolve(code ?? 1));
      });

      if (exitCode !== 0) {
        process.exit(exitCode);
      }

      console.log("\nPaste the full OAuth token (sk-ant-oat01-...) and press Enter:");
      process.stdout.write("> ");
      const readline = await import("readline");
      const rl = readline.createInterface({ input: process.stdin });
      let tokenBuf = "";
      const token = await new Promise<string>((resolve) => {
        rl.on("close", () => resolve(tokenBuf.trim()));
        rl.on("line", (line) => {
          tokenBuf += line.trim();
          if (tokenBuf.startsWith("sk-ant-oat") && tokenBuf.length >= 100) {
            rl.close();
          }
        });
      });

      if (token.startsWith("sk-ant-oat")) {
        const arkDir = join(process.env.HOME!, ".ark");
        mkdirSync(arkDir, { recursive: true });
        writeFileSync(join(arkDir, "claude-oauth-token"), token, { mode: 0o600 });
        console.log(`\n✓ Token saved to ~/.ark/claude-oauth-token`);
        console.log(`  TUI and dispatch will pick it up automatically.`);
      } else if (token) {
        console.log("\nToken doesn't look right (should start with sk-ant-oat). Try again.");
      }
    }
  });

// ── Search ──────────────────────────────────────────────────────────────────

program.command("search")
  .description("Search across sessions, events, messages, and transcripts")
  .argument("<query>", "Search text (case-insensitive)")
  .option("-l, --limit <n>", "Max results", "20")
  .option("-t, --transcripts", "Also search Claude transcripts (slower)")
  .option("--index", "Rebuild transcript search index before searching")
  .option("--hybrid", "Use hybrid search (memory + knowledge + transcripts with LLM re-ranking)")
  .action(async (query, opts) => {
    const ark = await getArkClient();
    if (opts.index) {
      console.log(chalk.dim("Indexing transcripts..."));
      await ark.historyIndex();
      const { stats } = await ark.indexStats();
      console.log(chalk.green(`Indexed entries from ${stats?.sessions ?? 0} sessions\n`));
    }

    const limit = parseInt(opts.limit);
    const results = await ark.sessionSearch(query);

    if (opts.transcripts) {
      const transcriptResults = await ark.historySearch(query, limit);
      results.push(...transcriptResults);
    }

    if (opts.hybrid) {
      const hybridResults = await core.hybridSearch(query, { limit, rerank: true });
      if (hybridResults.length === 0) {
        console.log(chalk.yellow("No hybrid search results found."));
        return;
      }
      console.log(chalk.bold(`Found ${hybridResults.length} result(s) via hybrid search for "${query}":\n`));
      for (const r of hybridResults) {
        const sourceColor = r.source === "memory" ? chalk.blue
          : r.source === "knowledge" ? chalk.cyan
          : chalk.magenta;
        const score = chalk.dim(`(${r.score.toFixed(2)})`);
        const content = r.content.length > 120 ? r.content.slice(0, 120) + "..." : r.content;
        console.log(`  ${sourceColor(`[${r.source}]`)} ${score}  ${content}`);
      }
      return;
    }

    if (results.length === 0) {
      console.log(chalk.yellow("No results found."));
      return;
    }

    console.log(chalk.bold(`Found ${results.length} result(s) for "${query}":\n`));
    for (const r of results) {
      const sourceColor = r.source === "metadata" ? chalk.blue
        : r.source === "event" ? chalk.cyan
        : r.source === "message" ? chalk.green
        : chalk.magenta;
      const match = r.match.length > 120 ? r.match.slice(0, 120) + "..." : r.match;
      console.log(`  ${chalk.dim(r.sessionId)}  ${sourceColor(`[${r.source}]`)}  ${match}`);
    }
  });

program.command("index")
  .description("Build or rebuild the transcript search index")
  .action(async () => {
    const ark = await getArkClient();
    console.log(chalk.dim("Indexing transcripts..."));
    const result = await ark.historyIndex();
    const { stats } = await ark.indexStats();
    console.log(chalk.green(`Indexed ${result.count ?? 0} entries from ${stats?.sessions ?? 0} sessions`));
  });

// ── Costs ──────────────────────────────────────────────────────────────────

program.command("costs")
  .description("Show cost summary across sessions")
  .option("-n, --limit <n>", "Number of sessions to show", "20")
  .action(async (opts) => {
    const ark = await getArkClient();
    const { costs, total } = await ark.costsRead();

    if (costs.length === 0) {
      console.log(chalk.dim("No cost data yet. Costs are tracked when sessions complete."));
      return;
    }

    console.log(chalk.bold(`\nTotal cost: ${core.formatCost(total)}\n`));
    console.log(chalk.dim("Session".padEnd(40) + "Model".padEnd(10) + "Cost".padEnd(10) + "Tokens"));
    console.log(chalk.dim("\u2500".repeat(75)));

    const limit = Number(opts.limit);
    for (const c of costs.slice(0, limit)) {
      const name = (c.summary ?? c.sessionId).slice(0, 38).padEnd(40);
      const model = (c.model ?? "?").padEnd(10);
      const cost = core.formatCost(c.cost).padEnd(10);
      const tokens = c.usage ? `${(c.usage.total_tokens / 1000).toFixed(0)}K` : "?";
      console.log(`${name}${model}${cost}${tokens}`);
    }

    if (costs.length > limit) {
      console.log(chalk.dim(`\n... and ${costs.length - limit} more sessions`));
    }
  });

program.command("costs-sync")
  .description("Backfill cost data from Claude transcripts")
  .action(() => {
    const result = core.syncCosts();
    console.log(chalk.green(`Synced: ${result.synced} sessions, Skipped: ${result.skipped}`));
  });

program.command("costs-export")
  .description("Export cost data")
  .option("--format <format>", "csv or json", "json")
  .option("-o, --output <file>", "Output file")
  .action(async (opts) => {
    const ark = await getArkClient();
    const sessions = await ark.sessionList({ limit: 500 });
    const data = opts.format === "csv" ? core.exportCostsCsv(sessions) : JSON.stringify(core.getAllSessionCosts(sessions), null, 2);
    if (opts.output) {
      writeFileSync(opts.output, data);
      console.log(chalk.green(`Exported to ${opts.output}`));
    } else {
      console.log(data);
    }
  });

// ── Schedules ───────────────────────────────────────────────────────────────

const schedule = program.command("schedule").description("Manage scheduled recurring sessions");

schedule.command("add")
  .description("Create a recurring scheduled session")
  .requiredOption("--cron <expression>", 'Cron expression (e.g., "0 2 * * *")')
  .option("-f, --flow <name>", "Flow name", "bare")
  .option("-r, --repo <path>", "Repository path")
  .option("-s, --summary <text>", "Session summary")
  .option("-c, --compute <name>", "Compute name")
  .option("-g, --group <name>", "Group name")
  .action(async (opts) => {
    const ark = await getArkClient();
    const sched = await ark.scheduleCreate({
      cron: opts.cron,
      flow: opts.flow,
      repo: opts.repo,
      summary: opts.summary,
      compute_name: opts.compute,
      group_name: opts.group,
    });
    console.log(chalk.green(`Schedule ${sched.id} created`));
    console.log(`  Cron:    ${sched.cron}`);
    console.log(`  Flow:    ${sched.flow}`);
    if (sched.repo) console.log(`  Repo:    ${sched.repo}`);
    if (sched.summary) console.log(`  Summary: ${sched.summary}`);
  });

schedule.command("list")
  .description("List all schedules")
  .action(async () => {
    const ark = await getArkClient();
    const schedules = await ark.scheduleList();
    if (schedules.length === 0) {
      console.log(chalk.yellow("No schedules."));
      return;
    }
    for (const s of schedules) {
      const status = s.enabled ? chalk.green("●") : chalk.dim("○");
      const lastRun = s.last_run ? s.last_run.slice(0, 19) : "never";
      console.log(`  ${status} ${chalk.dim(s.id)}  ${s.cron.padEnd(15)}  ${s.flow.padEnd(10)}  last:${lastRun}  ${s.summary || ""}`);
    }
  });

schedule.command("delete")
  .description("Delete a schedule")
  .argument("<id>", "Schedule ID")
  .action(async (id) => {
    const ark = await getArkClient();
    const ok = await ark.scheduleDelete(id);
    console.log(ok ? chalk.green(`Deleted ${id}`) : chalk.red(`Schedule ${id} not found`));
  });

schedule.command("enable")
  .description("Enable a schedule")
  .argument("<id>", "Schedule ID")
  .action(async (id) => {
    const ark = await getArkClient();
    await ark.scheduleEnable(id);
    console.log(chalk.green(`Enabled ${id}`));
  });

schedule.command("disable")
  .description("Disable a schedule")
  .argument("<id>", "Schedule ID")
  .action(async (id) => {
    const ark = await getArkClient();
    await ark.scheduleDisable(id);
    console.log(chalk.yellow(`Disabled ${id}`));
  });

// ── Exec (headless CI mode) ─────────────────────────────────────────────────

import { execSession } from "./exec.js";

program.command("exec")
  .description("Run a session non-interactively (for CI/CD)")
  .option("-r, --repo <path>", "Repository path", ".")
  .option("-s, --summary <text>", "Task summary")
  .option("-t, --ticket <key>", "Ticket reference")
  .option("-f, --flow <name>", "Flow name", "bare")
  .option("-c, --compute <name>", "Compute target")
  .option("-g, --group <name>", "Group name")
  .option("-a, --autonomy <level>", "Autonomy: full/execute/edit/read-only")
  .option("-o, --output <format>", "Output: text/json", "text")
  .option("--timeout <seconds>", "Timeout in seconds (0=unlimited)", "0")
  .action(async (opts) => {
    // ark exec needs the conductor running (for hooks)
    const { AppContext, setApp } = await import("../core/app.js");
    const { loadConfig } = await import("../core/config.js");
    const execApp = new AppContext(loadConfig());
    await execApp.boot();
    setApp(execApp);

    const code = await execSession({
      repo: opts.repo,
      summary: opts.summary,
      ticket: opts.ticket,
      flow: opts.flow,
      compute: opts.compute,
      group: opts.group,
      autonomy: opts.autonomy,
      output: opts.output,
      timeout: parseInt(opts.timeout),
    });

    await execApp.shutdown();
    process.exit(code);
  });

// ── Profile commands ────────────────────────────────────────────────────────

const profile = program.command("profile").description("Manage profiles");

profile.command("list")
  .description("List profiles")
  .action(async () => {
    const ark = await getArkClient();
    const { profiles, active } = await ark.profileList();
    for (const p of profiles) {
      const marker = p.name === active ? chalk.green(" (active)") : "";
      console.log(`  ${p.name}${marker}${p.description ? chalk.dim(` — ${p.description}`) : ""}`);
    }
  });

profile.command("create")
  .description("Create a profile")
  .argument("<name>")
  .argument("[description]")
  .action(async (name: string, desc: string | undefined) => {
    const ark = await getArkClient();
    try {
      await ark.profileCreate(name, desc);
      console.log(chalk.green(`Created profile: ${name}`));
    } catch (e: any) { console.log(chalk.red(e.message)); }
  });

profile.command("delete")
  .description("Delete a profile")
  .argument("<name>")
  .action(async (name: string) => {
    const ark = await getArkClient();
    try {
      await ark.profileDelete(name);
      console.log(chalk.green(`Deleted profile: ${name}`));
    } catch (e: any) { console.log(chalk.red(e.message)); }
  });

// ── Global search command ───────────────────────────────────────────────────

program.command("search-all")
  .description("Search across all Claude conversations")
  .argument("<query>")
  .option("-n, --limit <n>", "Max results", "20")
  .option("--days <n>", "Recent days to search", "90")
  .action((query: string, opts: { limit: string; days: string }) => {
    const results = core.searchAllConversations(query, {
      maxResults: Number(opts.limit),
      recentDays: Number(opts.days),
    });
    if (results.length === 0) {
      console.log(chalk.dim("No results"));
      return;
    }
    for (const r of results) {
      console.log(`${chalk.cyan(r.projectName)} ${chalk.dim(r.fileName)}`);
      console.log(`  ${r.matchLine.slice(0, 100)}`);
    }
  });

// ── Try (one-shot sandbox) ──────────────────────────────────────────────────

program.command("try")
  .description("Run a one-shot sandboxed session (auto-cleans up)")
  .argument("<task>")
  .option("--image <image>", "Docker image", "ubuntu:22.04")
  .action(async (task, opts) => {
    const ark = await getArkClient();
    const workdir = process.cwd();
    const session = await ark.sessionStart({
      summary: `[try] ${task}`,
      repo: workdir,
      workdir,
      config: { sandbox: true, sandboxImage: opts.image },
    });
    console.log(chalk.cyan(`Try session: ${session.id}`));
    console.log(chalk.dim("Session will be auto-deleted when done."));

    if (!core.isDockerAvailable()) {
      console.log(chalk.yellow("Warning: Docker not available. Running without sandbox."));
    }

    // Dispatch
    try {
      await ark.sessionDispatch(session.id);
    } catch (e: any) {
      console.log(chalk.red(`Dispatch failed: ${e.message}`));
    }

    // Re-fetch session (dispatch updates session_id in DB)
    const { session: updated } = await ark.sessionRead(session.id);
    if (updated?.session_id) {
      try {
        const cmd = core.attachCommand(updated.session_id);
        execSync(cmd, { stdio: "inherit" });
      } catch { /* detached */ }
    }

    // Auto-cleanup
    await ark.sessionDelete(session.id);
    console.log(chalk.dim("Try session cleaned up."));
  });

// ── Config ─────────────────────────────────────────────────────────────────

program.command("config")
  .description("Open Ark config in your editor")
  .option("--path", "Just print the config path")
  .action((opts) => {
    const configPath = join(core.ARK_DIR(), "config.yaml");

    // Create default config if missing
    if (!existsSync(configPath)) {
      mkdirSync(require("path").dirname(configPath), { recursive: true });
      writeFileSync(configPath, [
        "# Ark configuration",
        "# See: https://github.com/your-org/ark#configuration",
        "",
        "# hotkeys:",
        "#   delete: x",
        "#   fork: f",
        "",
        "# budgets:",
        "#   dailyLimit: 50",
        "#   weeklyLimit: 200",
        "",
      ].join("\n"));
    }

    if (opts.path) {
      console.log(configPath);
      return;
    }

    const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
    console.log(chalk.dim(`Opening ${configPath} in ${editor}...`));
    // Interactive editor - requires shell stdio passthrough
    execSync(`${editor} ${configPath}`, { stdio: "inherit" });
  });

// ── Web dashboard ──────────────────────────────────────────────────────────

program.command("web")
  .description("Start web dashboard")
  .option("--port <port>", "Listen port", "8420")
  .option("--read-only", "Read-only mode")
  .option("--token <token>", "Bearer token for auth")
  .action(async (opts) => {
    const server = core.startWebServer({
      port: Number(opts.port),
      readOnly: opts.readOnly,
      token: opts.token,
    });
    console.log(chalk.green(`Ark web dashboard: ${server.url}`));
    console.log(chalk.dim("Press Ctrl+C to stop"));
    process.on("SIGINT", () => { server.stop(); process.exit(0); });
    await new Promise(() => {});
  });

// ── OpenAPI spec ──────────────────────────────────────────────────────────────

program.command("openapi")
  .description("Generate OpenAPI spec")
  .action(() => {
    console.log(JSON.stringify(core.generateOpenApiSpec(), null, 2));
  });

// ── MCP proxy (internal, used by pooled MCP configs) ────────────────────────

program.command("mcp-proxy")
  .description("Bridge stdin/stdout to a pooled MCP socket (internal)")
  .argument("<socket-path>")
  .action((socketPath) => {
    core.runMcpProxy(socketPath);
  });

// ── ACP (headless JSON-RPC protocol) ──────────────────────────────────────

program.command("acp")
  .description("Start headless ACP server on stdin/stdout (JSON-RPC)")
  .action(() => {
    core.runAcpServer();
  });

// ── Repo map ──────────────────────────────────────────────────────────────

program.command("repo-map")
  .description("Generate repository structure map")
  .argument("[dir]", "Directory to scan", ".")
  .option("--max-files <n>", "Max files to include", "500")
  .option("--max-depth <n>", "Max directory depth", "10")
  .option("--json", "Output as JSON instead of text")
  .action((dir, opts) => {
    const rootDir = resolve(dir);
    const map = core.generateRepoMap(rootDir, {
      maxFiles: Number(opts.maxFiles),
      maxDepth: Number(opts.maxDepth),
    });

    if (opts.json) {
      console.log(JSON.stringify(map, null, 2));
    } else {
      console.log(chalk.bold(`Repository map: ${rootDir}`));
      console.log(chalk.dim(`${map.totalFiles} files\n`));
      console.log(map.summary);
    }
  });

// ── Recipe eval ───────────────────────────────────────────────────────────

program.command("eval")
  .description("Evaluate a recipe by creating N test sessions")
  .argument("<recipe>", "Recipe name")
  .option("-n, --iterations <n>", "Number of iterations", "3")
  .action((recipe, opts) => {
    const result = core.evaluateRecipeSetup(recipe, Number(opts.iterations));
    if (result.iterations === 0) {
      console.log(chalk.red(`Recipe '${recipe}' not found.`));
      return;
    }
    console.log(chalk.bold(`Evaluation: ${recipe} (${result.iterations} iterations)\n`));
    for (const r of result.results) {
      const icon = r.status === "error" ? chalk.red("x") : chalk.green("ok");
      console.log(`  ${icon} ${r.sessionId || "N/A"} - ${r.status} (${r.durationMs}ms, $${r.cost.toFixed(4)})`);
      if (r.error) console.log(chalk.red(`     ${r.error}`));
    }
    console.log(`\n${chalk.bold("Summary:")}`);
    console.log(`  Success rate: ${(result.summary.successRate * 100).toFixed(0)}%`);
    console.log(`  Avg duration: ${result.summary.avgDurationMs.toFixed(0)}ms`);
    console.log(`  Avg cost:     $${result.summary.avgCost.toFixed(4)}`);
    console.log(`  Total cost:   $${result.summary.totalCost.toFixed(4)}`);
  });

// ── Server ──────────────────────────────────────────────────────────────────
const serverCmd = program.command("server").description("JSON-RPC server");

serverCmd
  .command("start")
  .description("Start the Ark server")
  .option("--stdio", "Use stdio transport (JSONL)")
  .option("--ws", "Use WebSocket transport")
  .option("-p, --port <port>", "WebSocket port", "19400")
  .action(async (opts) => {
    const { AppContext, loadConfig } = await import("../core/index.js");
    const { ArkServer } = await import("../server/index.js");
    const { registerAllHandlers } = await import("../server/register.js");

    const app = new AppContext(loadConfig());
    await app.boot();

    const server = new ArkServer();
    registerAllHandlers(server.router, app);

    if (opts.stdio) {
      server.startStdio();
      await new Promise(() => {});
    } else {
      const port = parseInt(opts.port);
      const ws = server.startWebSocket(port);
      console.log(`Ark server listening on ws://localhost:${port}`);
      process.on("SIGINT", () => { ws.stop(); app.shutdown(); process.exit(0); });
      await new Promise(() => {});
    }
  });

// ── Run ─────────────────────────────────────────────────────────────────────

await program.parseAsync(process.argv);

// Non-blocking update check
core.checkForUpdate().then(latest => {
  if (latest) console.error(chalk.yellow(`Update available: v${latest}`));
}).catch(() => {});

closeArkClient();
await app.shutdown();

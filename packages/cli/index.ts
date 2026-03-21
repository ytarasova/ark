#!/usr/bin/env node
/**
 * Ark CLI — autonomous agent ecosystem.
 *
 * ark session start --repo . --summary "Add auth" --dispatch
 * ark session list
 * ark session dispatch s-abc123
 * ark session attach s-abc123
 * ark tui
 */

import { Command } from "commander";
import chalk from "chalk";
import { resolve, basename } from "path";
import { existsSync } from "fs";
import { execSync } from "child_process";
import * as core from "../core/index.js";

const program = new Command()
  .name("ark")
  .description("Ark — autonomous agent ecosystem, JIRA to production")
  .version("0.1.0");

// ── Session commands ────────────────────────────────────────────────────────

const session = program.command("session").description("Manage SDLC pipeline sessions");

session.command("start")
  .description("Start a new session")
  .argument("[jira-key]", "Jira ticket key")
  .option("-r, --repo <path>", "Repository path or name")
  .option("-s, --summary <text>", "Task summary")
  .option("-p, --pipeline <name>", "Pipeline name", "default")
  .option("-c, --compute <name>", "Compute name")
  .option("-g, --group <name>", "Group name")
  .option("-d, --dispatch", "Auto-dispatch the first stage agent")
  .option("-a, --attach", "Dispatch and attach to the session")
  .action((jiraKey, opts) => {
    // resolve imported at top
    let workdir: string | undefined;
    let repo = opts.repo;
    if (repo) {
      const rp = resolve(repo);
      // existsSync imported at top
      if (existsSync(rp)) {
        workdir = rp;
        if (repo === "." || repo === "./") repo = basename(rp);
      }
    }

    const s = core.startSession({
      jira_key: jiraKey, jira_summary: opts.summary ?? jiraKey,
      repo, pipeline: opts.pipeline, compute_name: opts.compute,
      workdir, group_name: opts.group,
    });

    console.log(chalk.green(`Session ${s.id} created`));
    console.log(`  Summary:  ${s.jira_summary ?? "-"}`);
    console.log(`  Repo:     ${s.repo ?? "-"}`);
    console.log(`  Pipeline: ${s.pipeline}`);
    console.log(`  Stage:    ${s.stage ?? "-"}`);
    if (workdir) console.log(`  Workdir:  ${workdir}`);

    if (opts.dispatch || opts.attach) {
      const result = core.dispatch(s.id);
      if (result.ok) {
        console.log(chalk.green(`Agent dispatched — session: ${result.message}`));
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
  .action((opts) => {
    const sessions = core.listSessions(opts);
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
      const summary = s.jira_summary ?? s.jira_key ?? s.repo ?? "-";
      console.log(`  ${color(icon)} ${s.id}  ${group}${summary.slice(0, 40)}  ${s.stage ?? "-"}  ${s.status}`);
    }
  });

session.command("show")
  .description("Show session details")
  .argument("<id>", "Session ID")
  .action((id) => {
    const s = core.getSession(id);
    if (!s) { console.log(chalk.red(`Session ${id} not found`)); return; }
    console.log(chalk.bold(`\n${s.jira_key ?? s.id}: ${s.jira_summary ?? ""}`));
    console.log(`  ID:       ${s.id}`);
    console.log(`  Status:   ${s.status}`);
    console.log(`  Stage:    ${s.stage ?? "-"}`);
    console.log(`  Repo:     ${s.repo ?? "-"}`);
    console.log(`  Pipeline: ${s.pipeline}`);
    if (s.agent) console.log(`  Agent:    ${s.agent}`);
    if (s.error) console.log(chalk.red(`  Error:    ${s.error}`));
    if (s.breakpoint_reason) console.log(chalk.yellow(`  Waiting:  ${s.breakpoint_reason}`));
  });

session.command("dispatch")
  .description("Dispatch the agent for the current stage")
  .argument("<id>", "Session ID")
  .action((id) => {
    const r = core.dispatch(id);
    console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
  });

session.command("stop")
  .description("Stop a session")
  .argument("<id>")
  .action((id) => {
    const r = core.stop(id);
    console.log(r.ok ? chalk.yellow("Stopped") : chalk.red(r.message));
  });

session.command("resume")
  .description("Resume a stopped/paused session")
  .argument("<id>")
  .action((id) => {
    const r = core.resume(id);
    console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
  });

session.command("advance")
  .description("Advance to the next pipeline stage")
  .argument("<id>")
  .option("-f, --force", "Force past gate")
  .action((id, opts) => {
    const r = core.advance(id, opts.force);
    console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
  });

session.command("complete")
  .description("Mark current stage done and advance")
  .argument("<id>")
  .action((id) => {
    const r = core.complete(id);
    console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
  });

session.command("pause")
  .description("Pause a session")
  .argument("<id>")
  .option("-r, --reason <text>")
  .action((id, opts) => {
    const r = core.pause(id, opts.reason);
    console.log(r.ok ? chalk.yellow("Paused") : chalk.red(r.message));
  });

session.command("attach")
  .description("Attach to a running agent session")
  .argument("<id>")
  .action((id) => {
    let s = core.getSession(id);
    if (!s) { console.log(chalk.red("Not found")); return; }
    if (!s.session_id) {
      console.log(chalk.yellow("No active session. Dispatching..."));
      const r = core.dispatch(id);
      if (!r.ok) { console.log(chalk.red(r.message)); return; }
      s = core.getSession(id)!;
    }
    const cmd = core.attachCommand(s.session_id!);
    require("child_process").execSync(cmd, { stdio: "inherit" });
  });

session.command("output")
  .description("Show live output from a running session")
  .argument("<id>")
  .option("-n, --lines <n>", "Number of lines", "30")
  .action((id, opts) => {
    const output = core.getOutput(id, { lines: Number(opts.lines) });
    console.log(output || chalk.dim("No output"));
  });

session.command("send")
  .description("Send a message to a running Claude session")
  .argument("<id>")
  .argument("<message>")
  .action((id, message) => {
    const r = core.send(id, message);
    console.log(r.ok ? chalk.green("Sent") : chalk.red(r.message));
  });

session.command("clone")
  .description("Clone a session (resumes Claude conversation)")
  .argument("<id>")
  .option("-t, --task <text>", "New task description")
  .option("-d, --dispatch", "Auto-dispatch")
  .action((id, opts) => {
    const r = core.cloneSession(id, opts.task);
    if (r.ok) {
      console.log(chalk.green(`Cloned → ${r.cloneId}`));
      if (opts.dispatch) core.dispatch(r.cloneId);
    } else {
      console.log(chalk.red(r.cloneId));
    }
  });

session.command("handoff")
  .description("Hand off to a different agent")
  .argument("<id>")
  .argument("<agent>")
  .option("-i, --instructions <text>")
  .action((id, agent, opts) => {
    const r = core.handoff(id, agent, opts.instructions);
    console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
  });

session.command("fork")
  .description("Fork a child session for parallel work")
  .argument("<parent-id>")
  .argument("<task>")
  .action((parentId, task) => {
    const r = core.fork(parentId, task);
    console.log(r.ok ? chalk.green(`Forked → ${r.childId}`) : chalk.red(r.childId));
  });

session.command("join")
  .description("Join all forked children")
  .argument("<parent-id>")
  .option("-f, --force")
  .action((parentId, opts) => {
    const r = core.joinFork(parentId, opts.force);
    console.log(r.ok ? chalk.green(r.message) : chalk.yellow(r.message));
  });

session.command("events")
  .description("Show event history")
  .argument("<id>")
  .action((id) => {
    const events = core.getEvents(id);
    for (const e of events) {
      const ts = e.created_at.slice(11, 19);
      const data = e.data ? Object.entries(e.data).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(" ") : "";
      console.log(`  ${chalk.dim(ts)}  ${e.type.padEnd(22)} ${chalk.cyan(e.stage ?? "")}  ${chalk.dim(data)}`);
    }
  });

session.command("delete")
  .description("Delete sessions")
  .argument("<ids...>")
  .action((ids: string[]) => {
    for (const id of ids) {
      const s = core.getSession(id);
      if (s?.session_id) core.killSession(s.session_id);
      core.deleteSession(id);
      console.log(chalk.green(`Deleted ${id}`));
    }
  });

session.command("group")
  .description("Assign a session to a group")
  .argument("<id>")
  .argument("<group>")
  .action((id, group) => {
    core.updateSession(id, { group_name: group });
    console.log(chalk.green(`${id} → group '${group}'`));
  });

// ── Agent commands ──────────────────────────────────────────────────────────

const agent = program.command("agent").description("Manage agent definitions");

agent.command("list").description("List agents").action(() => {
  for (const a of core.listAgents()) {
    console.log(`  ${a.name.padEnd(16)} ${a.model.padEnd(8)} T:${a.tools.length} M:${a.mcp_servers.length} S:${a.skills.length} R:${a.memories.length}  ${a.description.slice(0, 40)}`);
  }
});

agent.command("show").description("Show agent details").argument("<name>").action((name) => {
  const a = core.loadAgent(name);
  if (!a) { console.log(chalk.red("Not found")); return; }
  console.log(chalk.bold(`\n${a.name}`) + chalk.dim(` (${a._source})`));
  console.log(`  Model:      ${a.model}`);
  console.log(`  Max turns:  ${a.max_turns}`);
  console.log(`  Tools:      ${a.tools.join(", ")}`);
  console.log(`  MCPs:       ${a.mcp_servers.length ? a.mcp_servers.join(", ") : "-"}`);
  console.log(`  Skills:     ${a.skills.length ? a.skills.join(", ") : "-"}`);
  console.log(`  Memories:   ${a.memories.length ? a.memories.join(", ") : "-"}`);
});

// ── Pipeline commands ───────────────────────────────────────────────────────

const pipe = program.command("pipeline").description("Manage pipelines");

pipe.command("list").description("List pipelines").action(() => {
  for (const p of core.listPipelines()) {
    console.log(`  ${p.name.padEnd(16)} ${p.stages.join(" > ")}  ${chalk.dim(p.description.slice(0, 40))}`);
  }
});

pipe.command("show").description("Show pipeline").argument("<name>").action((name) => {
  const p = core.loadPipeline(name);
  if (!p) { console.log(chalk.red("Not found")); return; }
  console.log(chalk.bold(`\n${p.name}`));
  if (p.description) console.log(chalk.dim(`  ${p.description}`));
  for (const [i, s] of p.stages.entries()) {
    const type = s.type ?? (s.action ? "action" : "agent");
    const detail = s.agent ?? s.action ?? "";
    console.log(`  ${i + 1}. ${s.name.padEnd(14)} [${type}:${detail}] gate=${s.gate}${s.optional ? " (optional)" : ""}`);
  }
});

// ── TUI command ─────────────────────────────────────────────────────────────

program.command("tui").description("Launch TUI dashboard").action(async () => {
  await import("../tui/index.js");
});

// ── Conductor command ────────────────────────────────────────────────────────

program.command("conductor")
  .description("Start the conductor server")
  .option("-p, --port <port>", "Port", "19100")
  .action(async (opts) => {
    const { startConductor } = await import("../core/conductor.js");
    startConductor(parseInt(opts.port));
    // Keep alive
    setInterval(() => {}, 60_000);
  });

// ── Run ─────────────────────────────────────────────────────────────────────

program.parse();

import type { Command } from "commander";
import chalk from "chalk";
import { resolve, basename } from "path";
import { existsSync } from "fs";
import { execSync } from "child_process";
import * as core from "../../core/index.js";
import { runVerification } from "../../core/services/session-orchestration.js";
import { getArkClient } from "./_shared.js";
import { sanitizeSummary } from "../helpers.js";

async function forkCloneHandler(id: string, opts: { task?: string; group?: string; dispatch?: boolean }) {
  const ark = await getArkClient();
  try {
    const forked = await ark.sessionClone(id, opts.task);
    if (opts.group) await ark.sessionUpdate(forked.id, { group_name: opts.group });
    console.log(chalk.green(`Forked → ${forked.id}`));
    if (opts.dispatch) await ark.sessionDispatch(forked.id);
  } catch (e: any) {
    console.log(chalk.red(e.message));
  }
}

export function registerSessionCommands(program: Command) {
  const session = program.command("session").description("Manage SDLC flow sessions");

  session.command("start")
    .description("Start a new session")
    .argument("[ticket]", "External ticket reference (Jira key, GitHub issue, etc.)")
    .option("-r, --repo <path>", "Repository path or name")
    .option("--remote-repo <url>", "Git URL to clone on compute target (no local repo needed)")
    .option("-s, --summary <text>", "Task summary")
    .option("-p, --flow <name>", "Flow name", "default")
    .option("-c, --compute <name>", "Compute name")
    .option("-g, --group <name>", "Group name")
    .option("-d, --dispatch", "Auto-dispatch the first stage agent")
    .option("-a, --attach", "Dispatch and attach to the session")
    .option("--claude-session <id>", "Create from an existing Claude Code session (use 'ark claude list' to find IDs)")
    .option("--recipe <name>", "Create session from a recipe template")
    .action(async (ticket, opts) => {
      const { checkPrereqs, hasRequiredPrereqs, formatPrereqCheck } = await import("../../core/prereqs.js");
      const prereqs = checkPrereqs();
      if (!hasRequiredPrereqs(prereqs)) {
        console.log(chalk.red("Missing required tools:"));
        console.log(formatPrereqCheck(prereqs));
        process.exit(1);
      }

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
        const cs = await core.getClaudeSession(core.getApp(), opts.claudeSession);
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

      // Handle --remote-repo: use git URL as repo, no local path needed
      let sessionConfig: Record<string, unknown> | undefined;
      if (opts.remoteRepo) {
        if (!repo) {
          // Extract repo name from git URL for display
          const urlMatch = opts.remoteRepo.match(/\/([^/]+?)(?:\.git)?$/);
          repo = urlMatch?.[1] ?? opts.remoteRepo;
        }
        sessionConfig = { remoteRepo: opts.remoteRepo };
        console.log(chalk.dim(`Remote repo: ${opts.remoteRepo}`));
      }

      // Sanitize session name: alphanumeric, dash, underscore only
      const rawName = opts.summary ?? ticket ?? "";
      const summary = sanitizeSummary(rawName);
      if (summary !== rawName) console.log(`Note: session name sanitized to "${summary}"`);

      const s = await ark.sessionStart({
        ticket, summary,
        repo, flow: opts.flow, compute_name: opts.compute,
        agent: recipeAgent,
        workdir, group_name: opts.group,
        ...(sessionConfig ? { config: sessionConfig } : {}),
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
    .option("--archived", "Include archived sessions")
    .action(async (opts) => {
      const ark = await getArkClient();
      const filters: Record<string, unknown> = { ...opts, groupPrefix: core.profileGroupPrefix() || undefined };
      if (opts.archived) filters.status = "archived";
      delete filters.archived;
      const sessions = await ark.sessionList(filters as import("../../types/index.js").SessionListParams & Record<string, unknown>);
      if (!sessions.length) {
        console.log(chalk.dim("No sessions. Start one: ark session start --repo . --summary 'task'"));
        return;
      }
      const icons: Record<string, string> = {
        running: "●", waiting: "⏸", pending: "○", ready: "◎",
        completed: "✓", failed: "✕", blocked: "■", archived: "▪",
      };
      const colors: Record<string, (s: string) => string> = {
        running: chalk.blue, waiting: chalk.yellow, completed: chalk.green,
        failed: chalk.red, blocked: chalk.yellow, archived: chalk.dim,
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
    .option("--force", "Skip verification checks")
    .action(async (id, opts) => {
      if (!opts.force) {
        // Run verification first
        const result = await runVerification(core.getApp(), id);
        if (!result.ok) {
          console.log(chalk.red("Verification failed:"));
          console.log(chalk.red(result.message));
          console.log(chalk.dim("Use --force to skip verification"));
          return;
        }
        console.log(chalk.green("Verification passed"));
      }
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

  session.command("interrupt")
    .description("Interrupt a running agent (Ctrl+C) without killing the session")
    .argument("<id>", "Session ID")
    .action(async (id) => {
      const ark = await getArkClient();
      const result = await ark.sessionInterrupt(id);
      console.log(result.ok ? chalk.green(result.message) : chalk.red(result.message));
    });

  session.command("archive")
    .description("Archive a session for later reference")
    .argument("<id>", "Session ID")
    .action(async (id) => {
      const ark = await getArkClient();
      const result = await ark.sessionArchive(id);
      console.log(result.ok ? chalk.green(result.message) : chalk.red(result.message));
    });

  session.command("restore")
    .description("Restore an archived session")
    .argument("<id>", "Session ID")
    .action(async (id) => {
      const ark = await getArkClient();
      const result = await ark.sessionRestore(id);
      console.log(result.ok ? chalk.green(result.message) : chalk.red(result.message));
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
      execSync(cmd, { stdio: "inherit" });
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
    .action(forkCloneHandler);

  session.command("clone")
    .description("Alias for fork (branches the conversation)")
    .argument("<id>")
    .option("-t, --task <text>", "Task description for forked session")
    .option("-g, --group <name>", "Group for forked session")
    .option("-d, --dispatch", "Auto-dispatch")
    .action(forkCloneHandler);

  session.command("todo")
    .description("Manage session verification todos")
    .argument("<action>", "add|list|done|delete")
    .argument("<session-id>", "Session ID")
    .argument("[text]", "Todo content (for add) or todo ID (for done/delete)")
    .action(async (action, id, text) => {
      switch (action) {
        case "list": {
          const todos = core.getApp().todos.list(id);
          if (todos.length === 0) {
            console.log(chalk.dim("No todos"));
          } else {
            for (const t of todos) {
              const mark = t.done ? chalk.green("[x]") : chalk.red("[ ]");
              console.log(`${mark} #${t.id} ${t.content}`);
            }
          }
          break;
        }
        case "add": {
          if (!text) { console.log(chalk.red("Usage: ark session todo add <session-id> <content>")); return; }
          const todo = core.getApp().todos.add(id, text);
          console.log(chalk.green(`Added todo #${todo.id}: ${todo.content}`));
          break;
        }
        case "done": {
          if (!text) { console.log(chalk.red("Usage: ark session todo done <session-id> <todo-id>")); return; }
          const todo = core.getApp().todos.toggle(parseInt(text, 10));
          if (todo) {
            console.log(chalk.green(`Todo #${todo.id} ${todo.done ? "done" : "undone"}`));
          } else {
            console.log(chalk.red("Todo not found"));
          }
          break;
        }
        case "delete": {
          if (!text) { console.log(chalk.red("Usage: ark session todo delete <session-id> <todo-id>")); return; }
          const ok = core.getApp().todos.delete(parseInt(text, 10));
          console.log(ok ? chalk.green("Deleted") : chalk.red("Not found"));
          break;
        }
        default:
          console.log(chalk.red(`Unknown action: ${action}. Use add|list|done|delete`));
      }
    });

  session.command("verify")
    .description("Run verification scripts for a session")
    .argument("<id>", "Session ID")
    .action(async (id) => {
      console.log(chalk.dim("Running verification..."));
      const result = await runVerification(core.getApp(), id);
      if (result.ok) {
        console.log(chalk.green("Verification passed"));
      } else {
        console.log(chalk.red("Verification failed:"));
        if (!result.todosResolved) {
          console.log(chalk.red(`  ${result.pendingTodos.length} unresolved todo(s):`));
          for (const t of result.pendingTodos) {
            console.log(chalk.red(`    - ${t}`));
          }
        }
        for (const r of result.scriptResults) {
          if (!r.passed) {
            console.log(chalk.red(`  Script failed: ${r.script}`));
            if (r.output) console.log(chalk.dim(r.output.slice(0, 500)));
          }
        }
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
    .option("-a, --agent <agent>", "Agent override")
    .option("-m, --model <model>", "Model override (e.g., haiku, sonnet, opus)")
    .option("-d, --dispatch", "Auto-dispatch after spawning")
    .action(async (parentId, task, opts) => {
      const ark = await getArkClient();
      const r = await ark.sessionSpawn(parentId, {
        task,
        agent: opts.agent,
        model: opts.model,
      });
      if (r.ok) {
        console.log(chalk.green(`Spawned -> ${r.sessionId}`));
        if (opts.dispatch && r.sessionId) {
          const d = await ark.sessionDispatch(r.sessionId);
          console.log(d.ok ? chalk.green(`Dispatched: ${d.message}`) : chalk.red(d.message));
        }
      } else {
        console.log(chalk.red(r.message));
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
      const { formatEvent } = await import("../../tui/helpers/formatEvent.js");
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
      if (core.exportSessionToFile(core.getApp(), id, outPath)) {
        console.log(chalk.green(`Exported to ${outPath}`));
      } else {
        console.log(chalk.red("Session not found"));
      }
    });

  session.command("import")
    .description("Import session from file")
    .argument("<file>")
    .action((file) => {
      const result = core.importSessionFromFile(core.getApp(), file);
      console.log(result.ok ? chalk.green(result.message) : chalk.red(result.message));
    });
}

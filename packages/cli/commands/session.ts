import { type Command, Option } from "commander";
import chalk from "chalk";
import { resolve } from "path";
import { existsSync } from "fs";
import { execSync } from "child_process";
import * as core from "../../core/index.js";
import { SESSION_STATUSES } from "../../types/index.js";
import { runVerification } from "../../core/services/session-lifecycle.js";
import { getArkClient, getInProcessApp } from "../app-client.js";
import { sanitizeSummary, formatBytes } from "../helpers.js";
import { logDebug } from "../../core/observability/structured-log.js";

async function forkCloneHandler(id: string, opts: { task?: string; group?: string }) {
  const ark = await getArkClient();
  try {
    // Server auto-dispatches clones (see handler in packages/server/handlers/session.ts).
    const forked = await ark.sessionClone(id, opts.task);
    if (opts.group) await ark.sessionUpdate(forked.id, { group_name: opts.group });
    console.log(chalk.green(`Forked -> ${forked.id}`));
  } catch (e: any) {
    console.log(chalk.red(e.message));
  }
}

export function registerSessionCommands(program: Command) {
  const session = program.command("session").description("Manage SDLC flow sessions");

  session
    .command("start")
    .description("Start a new session")
    .argument("[ticket]", "External ticket reference (Jira key, GitHub issue, etc.)")
    .option("-r, --repo <path>", "Repository path or name")
    .option("--remote-repo <url>", "Git URL to clone on compute target (no local repo needed)")
    .option("-s, --summary <text>", "Task summary")
    .option("-p, --flow <name>", "Flow name", "default")
    .option("-c, --compute <name>", "Compute name")
    .option("-g, --group <name>", "Group name")
    .option("-a, --attach", "Attach to the session's tmux pane after starting")
    .option("--claude-session <id>", "Create from an existing Claude Code session (use 'ark claude list' to find IDs)")
    .option("--recipe <name>", "Create session from a recipe template")
    .option("--runtime <name>", "Override agent runtime (e.g. codex, gemini, claude)")
    .option(
      "--with-mcp <name>",
      "Mount an additional MCP server into the session (repeatable). Resolves against shipped mcp-configs/<name>.json or an inline path.",
      (value, prev: string[] = []) => [...prev, value],
      [] as string[],
    )
    .option(
      "--file <role=path>",
      "Attach a named file input (repeatable). Path is resolved absolute and exposed to agents + flows as {inputs.files.<role>}.",
      (value, prev: Record<string, string> = {}) => {
        const eq = value.indexOf("=");
        if (eq < 0) throw new Error(`--file expects role=path, got: ${value}`);
        const role = value.slice(0, eq).trim();
        const path = value.slice(eq + 1).trim();
        if (!role || !path) throw new Error(`--file expects role=path, got: ${value}`);
        return { ...prev, [role]: resolve(path) };
      },
      {} as Record<string, string>,
    )
    .option(
      "--param <k=v>",
      "Add a named param (repeatable). Exposed as {inputs.params.<k>} and, for goose runtimes, passed through as --params k=v.",
      (value, prev: Record<string, string> = {}) => {
        const eq = value.indexOf("=");
        if (eq < 0) throw new Error(`--param expects k=v, got: ${value}`);
        const k = value.slice(0, eq).trim();
        const v = value.slice(eq + 1);
        if (!k) throw new Error(`--param expects k=v, got: ${value}`);
        return { ...prev, [k]: v };
      },
      {} as Record<string, string>,
    )
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
          repo = rp;
        }
      }

      // Import from Claude session if specified
      let claudeSessionId: string | undefined;
      if (opts.claudeSession) {
        const app = await getInProcessApp();
        const cs = await core.getClaudeSession(app, opts.claudeSession);
        if (!cs) {
          console.log(
            chalk.red(
              `Claude session '${opts.claudeSession}' not found. Run 'ark claude list' to see available sessions.`,
            ),
          );
          return;
        }
        claudeSessionId = cs.sessionId;
        if (!opts.summary) opts.summary = cs.summary?.slice(0, 100) || `Imported from ${cs.sessionId.slice(0, 8)}`;
        if (!repo) {
          repo = cs.project;
        }
        if (!workdir) {
          workdir = cs.project;
        }
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
          if (!repo && instance.repo) {
            repo = instance.repo;
          }
          recipeAgent = instance.agent;
          console.log(chalk.dim(`Using recipe '${recipe.name}' (${recipe._source})`));
        } catch {
          console.error(chalk.red(`Recipe not found: ${opts.recipe}`));
          process.exit(1);
        }
      }

      // Handle --runtime: store runtime override in session config
      let sessionConfig: Record<string, unknown> | undefined;
      if (opts.runtime) {
        sessionConfig = { ...sessionConfig, runtime_override: opts.runtime };
      }

      // Handle --remote-repo: use git URL as repo, no local path needed
      if (opts.remoteRepo) {
        if (!repo) {
          // Extract repo name from git URL for display
          const urlMatch = opts.remoteRepo.match(/\/([^/]+?)(?:\.git)?$/);
          repo = urlMatch?.[1] ?? opts.remoteRepo;
        }
        sessionConfig = { ...sessionConfig, remoteRepo: opts.remoteRepo };
        console.log(chalk.dim(`Remote repo: ${opts.remoteRepo}`));
      }

      // Sanitize session name: alphanumeric, dash, underscore only
      const rawName = opts.summary ?? ticket ?? "";
      const summary = sanitizeSummary(rawName);
      if (summary !== rawName) console.log(`Note: session name sanitized to "${summary}"`);

      // Collect generic session inputs (files + params) and validate against
      // the flow's declared `inputs:` contract if present. Extra ad-hoc params
      // are always allowed; only declared-required entries block dispatch.
      const fileInputs: Record<string, string> = { ...(opts.file ?? {}) };
      const paramInputs: Record<string, string> = { ...(opts.param ?? {}) };

      try {
        const flowDef = opts.flow ? await ark.flowRead(opts.flow) : null;
        const declared = flowDef?.inputs;
        if (declared) {
          const missing: string[] = [];
          for (const [role, def] of Object.entries(declared.files ?? {})) {
            if (def?.required && !fileInputs[role]) missing.push(`--file ${role}=<path>`);
          }
          for (const [key, def] of Object.entries(declared.params ?? {})) {
            if (def?.required && paramInputs[key] === undefined) {
              if (def.default !== undefined) {
                paramInputs[key] = def.default;
              } else {
                missing.push(`--param ${key}=<value>`);
              }
            } else if (paramInputs[key] === undefined && def?.default !== undefined) {
              paramInputs[key] = def.default;
            }
            if (def?.pattern && paramInputs[key] !== undefined) {
              const re = new RegExp(def.pattern);
              if (!re.test(paramInputs[key])) {
                console.error(chalk.red(`--param ${key}=${paramInputs[key]} does not match pattern ${def.pattern}`));
                process.exit(1);
              }
            }
          }
          if (missing.length) {
            console.error(chalk.red(`Flow '${opts.flow}' is missing required inputs:`));
            for (const m of missing) console.error(`  ${m}`);
            process.exit(1);
          }
        }
      } catch {
        logDebug("session", "flow/read may 404 for ad-hoc flows; fall through without validation.");
      }

      const inputs =
        Object.keys(fileInputs).length || Object.keys(paramInputs).length
          ? {
              ...(Object.keys(fileInputs).length ? { files: fileInputs } : {}),
              ...(Object.keys(paramInputs).length ? { params: paramInputs } : {}),
            }
          : undefined;

      const s = await ark.sessionStart({
        ticket,
        summary,
        repo,
        flow: opts.flow,
        compute_name: opts.compute,
        agent: recipeAgent,
        workdir,
        group_name: opts.group,
        ...(sessionConfig ? { config: sessionConfig } : {}),
        ...(inputs ? { inputs } : {}),
      });

      if (claudeSessionId) {
        await ark.sessionUpdate(s.id, { claude_session_id: claudeSessionId });
        console.log(
          chalk.dim(`  Bound to Claude session: ${claudeSessionId.slice(0, 8)} (will use --resume on dispatch)`),
        );
      }

      console.log(chalk.green(`Session ${s.id} created + dispatched`));
      console.log(`  Summary:  ${s.summary ?? "-"}`);
      console.log(`  Repo:     ${s.repo ?? "-"}`);
      console.log(`  Flow:     ${s.flow}`);
      console.log(`  Stage:    ${s.stage ?? "-"}`);
      if (workdir) console.log(`  Workdir:  ${workdir}`);
      if (opts.runtime) console.log(`  Runtime:  ${opts.runtime}`);

      // Server handler now dispatches the first-stage agent atomically. Re-read
      // the session so --attach picks up the now-populated session_id.
      if (opts.attach) {
        const { session: ready } = await ark.sessionRead(s.id);
        if (ready?.session_id) {
          const attachCmd = core.attachCommand(ready.session_id);
          execSync(attachCmd, { stdio: "inherit" });
        } else if (ready?.error) {
          console.log(chalk.red(`Dispatch failed: ${ready.error}`));
        }
      }
    });

  session
    .command("list")
    .description("List all sessions")
    .addOption(new Option("-s, --status <status>", "Filter by status").choices(SESSION_STATUSES as unknown as string[]))
    .option("-r, --repo <repo>", "Filter by repo")
    .option("-g, --group <group>", "Filter by group")
    .option("--archived", "Include archived sessions")
    .action(async (opts) => {
      const ark = await getArkClient();
      const filters: Record<string, unknown> = { ...opts, groupPrefix: core.profileGroupPrefix() || undefined };
      if (opts.archived) filters.status = "archived";
      delete filters.archived;
      const sessions = await ark.sessionList(
        filters as import("../../types/index.js").SessionListParams & Record<string, unknown>,
      );
      if (!sessions.length) {
        console.log(chalk.dim("No sessions. Start one: ark session start --repo . --summary 'task'"));
        return;
      }
      const icons: Record<string, string> = {
        running: "●",
        waiting: "⏸",
        pending: "○",
        ready: "◎",
        completed: "✓",
        failed: "✕",
        blocked: "■",
        archived: "▪",
      };
      const colors: Record<string, (s: string) => string> = {
        running: chalk.blue,
        waiting: chalk.yellow,
        completed: chalk.green,
        failed: chalk.red,
        blocked: chalk.yellow,
        archived: chalk.dim,
      };
      for (const s of sessions) {
        const icon = icons[s.status] ?? "?";
        const color = colors[s.status] ?? chalk.dim;
        const group = s.group_name ? chalk.dim(`[${s.group_name}] `) : "";
        const summary = s.summary ?? s.ticket ?? s.repo ?? "-";
        console.log(`  ${color(icon)} ${s.id}  ${group}${summary.slice(0, 40)}  ${s.stage ?? "-"}  ${s.status}`);
      }
    });

  session
    .command("show")
    .description("Show session details")
    .argument("<id>", "Session ID")
    .action(async (id) => {
      const ark = await getArkClient();
      let s: any;
      try {
        const result = await ark.sessionRead(id);
        s = result.session;
      } catch (e: any) {
        console.log(chalk.red(e.message ?? `Session ${id} not found`));
        return;
      }
      if (!s) {
        console.log(chalk.red(`Session ${id} not found`));
        return;
      }
      console.log(chalk.bold(`\n${s.ticket ?? s.id}: ${s.summary ?? ""}`));
      console.log(`  ID:       ${s.id}`);
      console.log(`  Status:   ${s.status ?? "unknown"}`);
      console.log(`  Stage:    ${s.stage ?? "-"}`);
      console.log(`  Repo:     ${s.repo ?? "-"}`);
      console.log(`  Flow:     ${s.flow ?? "-"}`);
      console.log(`  Agent:    ${s.agent ?? "-"}`);
      if (s.branch) console.log(`  Branch:   ${s.branch}`);
      if (s.pr_url) console.log(`  PR:       ${s.pr_url}`);
      if (s.workdir) console.log(`  Workdir:  ${s.workdir}`);
      if (s.error) console.log(chalk.red(`  Error:    ${s.error}`));
      if (s.breakpoint_reason) console.log(chalk.yellow(`  Waiting:  ${s.breakpoint_reason}`));
    });

  session
    .command("stop")
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

  session
    .command("resume")
    .description("Resume a stopped/paused session (restores snapshot when available)")
    .argument("<id>")
    .option("--snapshot-id <id>", "Restore from a specific snapshot id (defaults to the session's latest)")
    .action(async (id, opts) => {
      const ark = await getArkClient();
      const r = await ark.sessionResume(id, opts.snapshotId);
      if (r.ok) {
        const extra = r.snapshotId ? chalk.dim(`  (snapshot ${r.snapshotId})`) : "";
        console.log(chalk.green(r.message ?? "Resumed") + extra);
      } else {
        console.log(chalk.red(r.message));
      }
    });

  session
    .command("advance")
    .description("Advance to the next flow stage")
    .argument("<id>")
    .option("-f, --force", "Force past gate")
    .action(async (id, opts) => {
      const ark = await getArkClient();
      const r = await ark.sessionAdvance(id, opts.force);
      console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
    });

  session
    .command("approve")
    .description("Approve a review gate and advance to the next stage")
    .argument("<id>")
    .action(async (id) => {
      const ark = await getArkClient();
      const r = await ark.gateApprove(id);
      console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
    });

  session
    .command("reject")
    .description("Reject a review gate and dispatch a rework cycle with the given reason")
    .argument("<id>")
    .requiredOption("-r, --reason <text>", "Why the change needs rework (shown to the agent)")
    .action(async (id, opts) => {
      const ark = await getArkClient();
      const reason = String(opts.reason ?? "").trim();
      if (!reason) {
        console.log(chalk.red("--reason is required"));
        process.exitCode = 1;
        return;
      }
      const r = await ark.sessionReject(id, reason);
      console.log(r.ok ? chalk.green(r.message ?? "Rework dispatched") : chalk.red(r.message ?? "Reject failed"));
    });

  session
    .command("complete")
    .description("Mark current stage done and advance")
    .argument("<id>")
    .option("--force", "Skip verification checks")
    .action(async (id, opts) => {
      if (!opts.force) {
        // Run verification first
        const app = await getInProcessApp();
        const result = await runVerification(app, id);
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

  session
    .command("pause")
    .description("Pause a session (persists a snapshot when the compute supports it)")
    .argument("<id>")
    .option("-r, --reason <text>")
    .action(async (id, opts) => {
      const ark = await getArkClient();
      const r = await ark.sessionPause(id, opts.reason);
      if (!r.ok) {
        console.log(chalk.red(r.message));
        return;
      }
      if (r.snapshot) {
        console.log(
          chalk.yellow("Paused") + chalk.dim(`  (snapshot ${r.snapshot.id}, ${formatBytes(r.snapshot.sizeBytes)})`),
        );
      } else if (r.notSupported) {
        console.log(chalk.yellow("Paused") + chalk.dim("  (no snapshot: compute does not support snapshots)"));
      } else {
        console.log(chalk.yellow("Paused"));
      }
    });

  session
    .command("interrupt")
    .description("Interrupt a running agent (Ctrl+C) without killing the session")
    .argument("<id>", "Session ID")
    .action(async (id) => {
      const ark = await getArkClient();
      const result = await ark.sessionInterrupt(id);
      console.log(result.ok ? chalk.green(result.message) : chalk.red(result.message));
    });

  session
    .command("archive")
    .description("Archive a session for later reference")
    .argument("<id>", "Session ID")
    .action(async (id) => {
      const ark = await getArkClient();
      const result = await ark.sessionArchive(id);
      console.log(result.ok ? chalk.green(result.message) : chalk.red(result.message));
    });

  session
    .command("restore")
    .description("Restore an archived session")
    .argument("<id>", "Session ID")
    .action(async (id) => {
      const ark = await getArkClient();
      const result = await ark.sessionRestore(id);
      console.log(result.ok ? chalk.green(result.message) : chalk.red(result.message));
    });

  session
    .command("attach")
    .description("Attach to a running agent session")
    .argument("<id>")
    .action(async (id) => {
      const ark = await getArkClient();
      const { session: s } = await ark.sessionRead(id);
      if (!s) {
        console.log(chalk.red("Not found"));
        return;
      }
      if (!s.session_id) {
        // Sessions now dispatch at start/fork/clone/spawn time. If there's
        // still no tmux session after that, it failed to launch -- `session
        // resume` is the right tool for restarting.
        console.log(chalk.red("Session is not running. Try `ark session resume`."));
        return;
      }
      const cmd = core.attachCommand(s.session_id);
      execSync(cmd, { stdio: "inherit" });
    });

  session
    .command("output")
    .description("Show live output from a running session")
    .argument("<id>")
    .option("-n, --lines <n>", "Number of lines", "30")
    .action(async (id, opts) => {
      const ark = await getArkClient();
      const output = await ark.sessionOutput(id, Number(opts.lines));
      console.log(output || chalk.dim("No output"));
    });

  session
    .command("send")
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

  session
    .command("undelete")
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

  session
    .command("fork")
    .description("Fork a session (branches the conversation)")
    .argument("<id>")
    .option("-t, --task <text>", "Task description for forked session")
    .option("-g, --group <name>", "Group for forked session")
    .action(forkCloneHandler);

  session
    .command("clone")
    .description("Alias for fork (branches the conversation)")
    .argument("<id>")
    .option("-t, --task <text>", "Task description for forked session")
    .option("-g, --group <name>", "Group for forked session")
    .action(forkCloneHandler);

  session
    .command("todo")
    .description("Manage session verification todos")
    .argument("<action>", "add|list|done|delete")
    .argument("<session-id>", "Session ID")
    .argument("[text]", "Todo content (for add) or todo ID (for done/delete)")
    .action(async (action, id, text) => {
      const ark = await getArkClient();
      switch (action) {
        case "list": {
          const { todos } = await ark.todoList(id);
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
          if (!text) {
            console.log(chalk.red("Usage: ark session todo add <session-id> <content>"));
            return;
          }
          const { todo } = await ark.todoAdd(id, text);
          console.log(chalk.green(`Added todo #${todo.id}: ${todo.content}`));
          break;
        }
        case "done": {
          if (!text) {
            console.log(chalk.red("Usage: ark session todo done <session-id> <todo-id>"));
            return;
          }
          const { todo } = await ark.todoToggle(parseInt(text, 10));
          if (todo) {
            console.log(chalk.green(`Todo #${todo.id} ${todo.done ? "done" : "undone"}`));
          } else {
            console.log(chalk.red("Todo not found"));
          }
          break;
        }
        case "delete": {
          if (!text) {
            console.log(chalk.red("Usage: ark session todo delete <session-id> <todo-id>"));
            return;
          }
          const { ok } = await ark.todoDelete(parseInt(text, 10));
          console.log(ok ? chalk.green("Deleted") : chalk.red("Not found"));
          break;
        }
        default:
          console.log(chalk.red(`Unknown action: ${action}. Use add|list|done|delete`));
      }
    });

  session
    .command("verify")
    .description("Run verification scripts for a session")
    .argument("<id>", "Session ID")
    .action(async (id) => {
      console.log(chalk.dim("Running verification..."));
      const app = await getInProcessApp();
      const result = await runVerification(app, id);
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

  session
    .command("handoff")
    .description("Hand off to a different agent")
    .argument("<id>")
    .argument("<agent>")
    .option("-i, --instructions <text>")
    .action(async (id, agent, opts) => {
      const ark = await getArkClient();
      const r = await ark.sessionHandoff(id, agent, opts.instructions);
      console.log(r.ok ? chalk.green(r.message) : chalk.red(r.message));
    });

  session
    .command("spawn")
    .description("Spawn a child session for parallel work")
    .argument("<parent-id>")
    .argument("<task>")
    .option("-a, --agent <agent>", "Agent override")
    .option("-m, --model <model>", "Model override (e.g., haiku, sonnet, opus)")
    .action(async (parentId, task, opts) => {
      const ark = await getArkClient();
      const r = await ark.sessionSpawn(parentId, {
        task,
        agent: opts.agent,
        model: opts.model,
      });
      if (r.ok) {
        // Server handler dispatches spawned children automatically.
        console.log(chalk.green(`Spawned + dispatched -> ${r.sessionId}`));
      } else {
        console.log(chalk.red(r.message));
      }
    });

  session
    .command("spawn-subagent")
    .description("Spawn a subagent with optional model/agent override")
    .argument("<parent-id>")
    .argument("<task>")
    .option("-m, --model <model>", "Model override (e.g., haiku, sonnet, opus)")
    .option("-a, --agent <agent>", "Agent override")
    .option("-g, --group <name>", "Group name")
    .action(async (parentId, task, opts) => {
      const ark = await getArkClient();
      const r = await ark.sessionSpawn(parentId, {
        task,
        agent: opts.agent,
        model: opts.model,
        group_name: opts.group,
      });
      if (r.ok) {
        console.log(chalk.green(`Subagent spawned + dispatched -> ${r.sessionId}`));
      } else {
        console.log(chalk.red(r.message));
      }
    });

  session
    .command("join")
    .description("Join all forked children")
    .argument("<parent-id>")
    .option("-f, --force")
    .action(async (parentId, opts) => {
      const ark = await getArkClient();
      const r = await ark.sessionJoin(parentId, opts.force);
      console.log(r.ok ? chalk.green(r.message) : chalk.yellow(r.message));
    });

  session
    .command("events")
    .description("Show event history")
    .argument("<id>")
    .action(async (id) => {
      const ark = await getArkClient();
      const { formatEvent } = await import("../helpers.js");
      const events = await ark.sessionEvents(id);
      for (const e of events) {
        const ts = e.created_at.slice(11, 16);
        const msg = formatEvent(e.type, e.data ?? undefined);
        console.log(`  ${chalk.dim(ts)}  ${msg}`);
      }
    });

  session
    .command("delete")
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

  session
    .command("group")
    .description("Assign a session to a group")
    .argument("<id>")
    .argument("<group>")
    .action(async (id, group) => {
      const ark = await getArkClient();
      await ark.sessionUpdate(id, { group_name: group });
      console.log(chalk.green(`${id} → group '${group}'`));
    });

  session
    .command("export")
    .description("Export session to file")
    .argument("<id>")
    .argument("[file]")
    .action(async (id, file) => {
      const outPath = file ?? `session-${id}.json`;
      const ark = await getArkClient();
      try {
        const result = await ark.sessionExport(id, outPath);
        if (result.ok) {
          console.log(chalk.green(`Exported to ${result.filePath ?? outPath}`));
        } else {
          console.log(chalk.red("Session not found"));
        }
      } catch (e: any) {
        console.log(chalk.red(e.message ?? "Export failed"));
      }
    });

  session
    .command("import")
    .description("Import session from file")
    .argument("<file>")
    .action(async (file) => {
      // Import remains local-only: it reads from the caller's filesystem and
      // writes rows into the DB. There is no import RPC yet; fall through to
      // the in-process app so the UX still works on a clean checkout.
      const app = await getInProcessApp();
      const result = await core.importSessionFromFile(app, file);
      console.log(result.ok ? chalk.green(result.message) : chalk.red(result.message));
    });
}

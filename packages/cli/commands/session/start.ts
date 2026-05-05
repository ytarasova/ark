import { type Command } from "commander";
import chalk from "chalk";
import { resolve } from "path";
import { execSync } from "child_process";
import * as core from "../../../core/index.js";
import { getArkClient, getInProcessApp } from "../../app-client.js";
import { SessionStartService, SessionStartPlanError } from "../../services/session-start.js";

export function registerStartCommands(session: Command) {
  session
    .command("start")
    .description("Start a new session")
    .argument("[ticket]", "External ticket reference (Jira key, GitHub issue, etc.)")
    .option("-r, --repo <path>", "Repository path or name")
    .option("--remote-repo <url>", "Git URL to clone on compute target (no local repo needed)")
    .option(
      "-b, --branch <name>",
      "Deterministic branch name for the worktree (default: derived from --ticket/--summary or auto)",
    )
    .option("-s, --summary <text>", "Task summary")
    .option(
      "-p, --flow <name-or-path>",
      "Flow name OR a path to an inline flow YAML. Paths ending in .yaml/.yml are read + parsed and forwarded as an inline flow definition; bare names hit the FlowStore.",
      "default",
    )
    .option("-c, --compute <name>", "Compute name")
    .option("-g, --group <name>", "Group name")
    .option("-a, --attach", "Attach to the session's tmux pane after starting")
    .option(
      "--max-budget <usd>",
      "Cumulative cost cap for this session in USD. Halts for_each if exceeded.",
      parseFloat,
    )
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
      "--param <k=value>",
      "Add a named input (repeatable). Exposed as {inputs.<k>}. Value is parsed as JSON when possible (arrays, objects, numbers, booleans, null) and falls back to a string otherwise. Use for any flow-declared input -- scalars, lists, nested objects.",
      (value, prev: Record<string, unknown> = {}) => {
        const eq = value.indexOf("=");
        if (eq < 0) throw new Error(`--param expects k=value, got: ${value}`);
        const k = value.slice(0, eq).trim();
        const raw = value.slice(eq + 1);
        if (!k) throw new Error(`--param expects k=value, got: ${value}`);
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Not valid JSON -- keep as a string.
        }
        return { ...prev, [k]: parsed };
      },
      {} as Record<string, unknown>,
    )
    .action(async (ticket, opts) => {
      const { checkPrereqs, hasRequiredPrereqs, formatPrereqCheck } = await import("../../../core/prereqs.js");
      const prereqs = checkPrereqs();
      if (!hasRequiredPrereqs(prereqs)) {
        console.log(chalk.red("Missing required tools:"));
        console.log(formatPrereqCheck(prereqs));
        process.exit(1);
      }

      const ark = await getArkClient();
      const planner = new SessionStartService({
        client: {
          flowRead: (name) => ark.flowRead(name),
        },
      });

      let plan;
      try {
        plan = await planner.plan(ticket, opts);
      } catch (err) {
        if (err instanceof SessionStartPlanError) {
          console.error(chalk.red(err.message));
          process.exit(1);
        }
        throw err;
      }

      for (const note of plan.notes) {
        if (note.kind === "warn") console.warn(chalk.yellow(note.message));
        else console.log(chalk.dim(note.message));
      }

      const s = await ark.sessionStart(plan.request);

      console.log(chalk.green(`Session ${s.id} created + dispatched`));
      console.log(`  Summary:  ${s.summary ?? "-"}`);
      console.log(`  Repo:     ${s.repo ?? "-"}`);
      if (s.branch) console.log(`  Branch:   ${s.branch}`);
      console.log(`  Flow:     ${s.flow}`);
      console.log(`  Stage:    ${s.stage ?? "-"}`);
      if (plan.request.workdir) console.log(`  Workdir:  ${plan.request.workdir}`);
      if (opts.runtime) console.log(`  Runtime:  ${opts.runtime}`);
      if (opts.model) console.log(`  Model:    ${opts.model}`);

      // Server handler now dispatches the first-stage agent atomically. Re-read
      // the session so --attach picks up the now-populated session_id.
      if (plan.attach) {
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
}

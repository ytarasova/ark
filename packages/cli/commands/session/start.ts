import { type Command } from "commander";
import chalk from "chalk";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import YAML from "yaml";
import * as core from "../../../core/index.js";
import { getArkClient, getInProcessApp } from "../../app-client.js";
import { sanitizeSummary } from "../../helpers.js";
import { logDebug } from "../../../core/observability/structured-log.js";

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
    .option("--claude-session <id>", "Create from an existing Claude Code session (use 'ark claude list' to find IDs)")
    .option("--recipe <name>", "Create session from a recipe template")
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
      const { checkPrereqs, hasRequiredPrereqs, formatPrereqCheck } = await import("../../../core/prereqs.js");
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

      // Inline flow support: `--flow ./foo.yaml` (or any path with a .yaml/.yml
      // suffix and an actual file behind it) is read + parsed and forwarded as
      // an inline flow object. Bare names still resolve via the FlowStore.
      let flowArg: string | Record<string, unknown> | undefined = opts.flow;
      if (typeof opts.flow === "string" && /\.(yaml|yml)$/i.test(opts.flow)) {
        const flowPath = resolve(opts.flow);
        if (existsSync(flowPath)) {
          try {
            flowArg = YAML.parse(readFileSync(flowPath, "utf-8")) as Record<string, unknown>;
            console.log(chalk.dim(`Parsed inline flow from ${flowPath}`));
          } catch (e: any) {
            console.error(chalk.red(`Failed to parse inline flow YAML at ${flowPath}: ${e?.message ?? e}`));
            process.exit(1);
          }
        }
      }

      let sessionConfig: Record<string, unknown> | undefined;
      if (typeof opts.maxBudget === "number" && Number.isFinite(opts.maxBudget)) {
        sessionConfig = { ...sessionConfig, max_budget_usd: opts.maxBudget };
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
        // Flow input validation: only run when the flow is passed by name
        // (a named flow lives in the FlowStore, so we can flowRead it). Inline
        // flows -- passed as an object -- carry their own declared inputs and
        // are validated server-side when the session dispatches.
        const flowDef =
          typeof opts.flow === "string" && !/\.(yaml|yml)$/i.test(opts.flow) ? await ark.flowRead(opts.flow) : null;
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
        ...(opts.branch ? { branch: opts.branch } : {}),
        flow: flowArg as string,
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
      if (s.branch) console.log(`  Branch:   ${s.branch}`);
      console.log(`  Flow:     ${s.flow}`);
      console.log(`  Stage:    ${s.stage ?? "-"}`);
      if (workdir) console.log(`  Workdir:  ${workdir}`);

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

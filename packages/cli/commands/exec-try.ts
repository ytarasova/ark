import type { Command } from "commander";
import chalk from "chalk";
import { execSync } from "child_process";
import * as core from "../../core/index.js";
import { AppContext, setApp } from "../../core/app.js";
import { loadConfig } from "../../core/config.js";
import { getArkClient } from "./_shared.js";
import { execSession } from "../exec.js";

/**
 * Headless + one-shot session commands. Extracted from misc.ts.
 *
 *   ark exec   - CI-oriented: starts a conductor-backed session, runs it
 *                to completion, exits with the session's result code.
 *   ark try    - interactive one-shot sandboxed session that deletes
 *                itself after the user attaches once.
 */
export function registerExecTryCommands(program: Command, app: AppContext | null) {
  program
    .command("exec")
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
      // `ark exec` needs the conductor running (for Claude Code hooks).
      if (app) await app.shutdown();
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

  program
    .command("try")
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
        } catch {
          /* session detached or user hit Ctrl-B-d */
        }
      }

      await ark.sessionDelete(session.id);
      console.log(chalk.dim("Try session cleaned up."));
    });
}

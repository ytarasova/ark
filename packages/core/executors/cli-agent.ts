/**
 * Generic CLI agent executor -- runs any CLI coding tool in tmux.
 *
 * Supports any agent that accepts tasks via stdin, file, or CLI args.
 * Examples: codex, gemini-cli, opencode, pi, amp, or any custom CLI tool.
 *
 * Agent YAML:
 *   runtime: cli-agent
 *   command: ["codex", "--model", "o4-mini"]
 *   task_delivery: stdin | file | arg   # how to send the task (default: stdin)
 */

import type { Executor, LaunchOpts, LaunchResult, ExecutorStatus } from "../executor.js";
import * as tmux from "../infra/tmux.js";
import { join } from "path";
import { writeFileSync, mkdirSync } from "fs";

export const cliAgentExecutor: Executor = {
  name: "cli-agent",

  async launch(opts: LaunchOpts): Promise<LaunchResult> {
    const app = opts.app!;
    const { sessionId, workdir, agent, task, stage: _stage, onLog: log = () => {}, initialPrompt } = opts;

    const command = agent.command;
    if (!command || command.length === 0) {
      return {
        ok: false,
        handle: "",
        message: 'Agent has no command defined. Add `command: ["tool", "args"]` to agent YAML.',
      };
    }

    // Worktree setup (reuse the shared function if available)
    let effectiveWorkdir = workdir;
    try {
      const { setupSessionWorktree } = await import("../services/session-orchestration.js");
      const session = app.sessions.get(sessionId);
      if (session) {
        const result = await setupSessionWorktree(app, session, null, null, log);
        if (result) effectiveWorkdir = result;
      }
    } catch {
      /* worktree setup optional */
    }

    // Build tmux session name
    const tmuxName = `ark-${sessionId}`;

    // Determine task delivery method
    const taskDelivery = ((agent as Record<string, unknown>).task_delivery as string) ?? "stdin";

    // Save task to file for file-based delivery
    const trackDir = join(app.config.tracksDir, sessionId);
    mkdirSync(trackDir, { recursive: true });
    const taskFile = join(trackDir, "task.txt");
    writeFileSync(taskFile, task);

    // Write env vars to a file and source it (avoids shell injection via env values)
    const { buildRouterEnv } = await import("./router-env.js");
    const mergedEnv = {
      ...agent.env,
      ...(opts.env ?? {}),
      ...buildRouterEnv(app.config, { mode: "openai" }),
    };

    const envFile = join(trackDir, "env.sh");
    const envLines = Object.entries(mergedEnv)
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
      .join("\n");
    writeFileSync(envFile, envLines);
    const envPrefix = envLines ? `source ${JSON.stringify(envFile)} && ` : "";

    // Determine the effective prompt: initialPrompt overrides task for delivery
    const effectiveTask = initialPrompt ?? task;

    // Build the command line
    let cmdLine: string;
    const cmdStr = command.join(" ");
    let sendPromptAfterLaunch = false;

    switch (taskDelivery) {
      case "file": {
        // Write the effective prompt to the task file for file-based delivery
        if (initialPrompt) writeFileSync(taskFile, initialPrompt);
        cmdLine = `${envPrefix}cd ${JSON.stringify(effectiveWorkdir)} && ${cmdStr} ${JSON.stringify(taskFile)}`;
        break;
      }
      case "arg": {
        // Pass task as the last CLI argument (truncated to 4000 chars for shell safety)
        const shortTask = effectiveTask.slice(0, 4000);
        cmdLine = `${envPrefix}cd ${JSON.stringify(effectiveWorkdir)} && ${cmdStr} ${JSON.stringify(shortTask)}`;
        break;
      }
      case "stdin":
      default:
        if (initialPrompt) {
          // Launch the CLI without piping, then send the prompt via tmux send-keys
          cmdLine = `${envPrefix}cd ${JSON.stringify(effectiveWorkdir)} && ${cmdStr}`;
          sendPromptAfterLaunch = true;
        } else {
          // Pipe task via stdin using file
          cmdLine = `${envPrefix}cd ${JSON.stringify(effectiveWorkdir)} && cat ${JSON.stringify(taskFile)} | ${cmdStr}`;
        }
        break;
    }

    // Launch in tmux
    log(`Launching ${command[0]} in tmux...`);
    await tmux.createSessionAsync(tmuxName, cmdLine, { arkDir: app.config.arkDir });
    const rootPid = await tmux.getPanePidAsync(tmuxName);

    // For stdin delivery with initialPrompt, send via tmux after the process starts
    if (sendPromptAfterLaunch && initialPrompt) {
      // Brief delay to let the process initialize before sending input
      await Bun.sleep(200);
      await tmux.sendTextAsync(tmuxName, initialPrompt);
    }

    return { ok: true, handle: tmuxName, pid: rootPid ?? undefined };
  },

  async kill(handle: string): Promise<void> {
    await tmux.killSessionAsync(handle);
  },

  async status(handle: string): Promise<ExecutorStatus> {
    const alive = await tmux.sessionExistsAsync(handle);
    if (alive) return { state: "running" };
    return { state: "not_found" };
  },

  async send(handle: string, message: string): Promise<void> {
    await tmux.sendTextAsync(handle, message);
  },

  async capture(handle: string, lines?: number): Promise<string> {
    return tmux.capturePaneAsync(handle, { lines: lines ?? 50 });
  },
};

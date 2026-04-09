/**
 * Generic CLI agent executor -- runs any CLI coding tool in tmux.
 *
 * Supports any agent that accepts tasks via stdin, file, or CLI args.
 * Examples: codex, gemini-cli, aider, cursor-agent, opencode, pi, amp.
 *
 * Agent YAML:
 *   runtime: cli-agent
 *   command: ["codex", "--model", "o4-mini"]
 *   task_delivery: stdin | file | arg   # how to send the task (default: stdin)
 */

import type { Executor, LaunchOpts, LaunchResult, ExecutorStatus } from "../executor.js";
import * as tmux from "../tmux.js";
import { join } from "path";
import { writeFileSync, mkdirSync } from "fs";

export const cliAgentExecutor: Executor = {
  name: "cli-agent",

  async launch(opts: LaunchOpts): Promise<LaunchResult> {
    const app = opts.app!;
    const { sessionId, workdir, agent, task, stage, onLog: log = () => {} } = opts;

    const command = agent.command;
    if (!command || command.length === 0) {
      return { ok: false, handle: "", message: "Agent has no command defined. Add `command: [\"tool\", \"args\"]` to agent YAML." };
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
    } catch { /* worktree setup optional */ }

    // Build tmux session name
    const tmuxName = `ark-${sessionId}`;

    // Determine task delivery method
    const taskDelivery = (agent as Record<string, unknown>).task_delivery as string ?? "stdin";

    // Save task to file for file-based delivery
    const trackDir = join(app.config.tracksDir, sessionId);
    mkdirSync(trackDir, { recursive: true });
    const taskFile = join(trackDir, "task.txt");
    writeFileSync(taskFile, task);

    // Write env vars to a file and source it (avoids shell injection via env values)
    const mergedEnv = { ...agent.env, ...(opts.env ?? {}) };
    const envFile = join(trackDir, "env.sh");
    const envLines = Object.entries(mergedEnv)
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
      .join("\n");
    writeFileSync(envFile, envLines);
    const envPrefix = envLines ? `source ${JSON.stringify(envFile)} && ` : "";

    // Build the command line
    let cmdLine: string;
    const cmdStr = command.join(" ");

    switch (taskDelivery) {
      case "file":
        // Pass task as a file path argument
        cmdLine = `${envPrefix}cd ${JSON.stringify(effectiveWorkdir)} && ${cmdStr} ${JSON.stringify(taskFile)}`;
        break;
      case "arg": {
        // Pass task as the last CLI argument (truncated to 4000 chars for shell safety)
        const shortTask = task.slice(0, 4000);
        cmdLine = `${envPrefix}cd ${JSON.stringify(effectiveWorkdir)} && ${cmdStr} ${JSON.stringify(shortTask)}`;
        break;
      }
      case "stdin":
      default:
        // Pipe task via stdin using file
        cmdLine = `${envPrefix}cd ${JSON.stringify(effectiveWorkdir)} && cat ${JSON.stringify(taskFile)} | ${cmdStr}`;
        break;
    }

    // Launch in tmux
    log(`Launching ${command[0]} in tmux...`);
    await tmux.createSessionAsync(tmuxName, cmdLine, { arkDir: app.config.arkDir });

    return { ok: true, handle: tmuxName };
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

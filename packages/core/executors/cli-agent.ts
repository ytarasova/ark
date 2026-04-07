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
import { getApp } from "../app.js";
import { join } from "path";
import { writeFileSync, mkdirSync } from "fs";
import { TRACKS_DIR } from "../paths.js";

export const cliAgentExecutor: Executor = {
  name: "cli-agent",

  async launch(opts: LaunchOpts): Promise<LaunchResult> {
    const { sessionId, workdir, agent, task, stage, onLog: log = () => {} } = opts;

    const command = agent.command;
    if (!command || command.length === 0) {
      return { ok: false, handle: "", message: "Agent has no command defined. Add `command: [\"tool\", \"args\"]` to agent YAML." };
    }

    // Worktree setup (reuse the shared function if available)
    let effectiveWorkdir = workdir;
    try {
      const { setupSessionWorktree } = await import("../services/session-orchestration.js");
      const session = getApp().sessions.get(sessionId);
      if (session) {
        const result = await setupSessionWorktree(session, null, null, log);
        if (result) effectiveWorkdir = result;
      }
    } catch { /* worktree setup optional */ }

    // Build tmux session name
    const tmuxName = `ark-${sessionId}`;

    // Determine task delivery method
    const taskDelivery = (agent as Record<string, unknown>).task_delivery as string ?? "stdin";

    // Save task to file for file-based delivery
    const trackDir = join(TRACKS_DIR(), sessionId);
    mkdirSync(trackDir, { recursive: true });
    const taskFile = join(trackDir, "task.txt");
    writeFileSync(taskFile, task);

    // Build the command line
    let cmdLine: string;
    const cmdStr = command.join(" ");
    const envExports = Object.entries({ ...agent.env, ...(opts.env ?? {}) })
      .map(([k, v]) => `export ${k}="${v.replace(/"/g, '\\"')}"`)
      .join("; ");
    const envPrefix = envExports ? `${envExports}; ` : "";

    switch (taskDelivery) {
      case "file":
        // Pass task as a file path argument
        cmdLine = `${envPrefix}cd "${effectiveWorkdir}" && ${cmdStr} "${taskFile}"`;
        break;
      case "arg":
        // Pass task as the last CLI argument (truncated to 4000 chars for shell safety)
        const shortTask = task.slice(0, 4000).replace(/"/g, '\\"').replace(/\n/g, "\\n");
        cmdLine = `${envPrefix}cd "${effectiveWorkdir}" && ${cmdStr} "${shortTask}"`;
        break;
      case "stdin":
      default:
        // Pipe task via stdin using file
        cmdLine = `${envPrefix}cd "${effectiveWorkdir}" && cat "${taskFile}" | ${cmdStr}`;
        break;
    }

    // Launch in tmux
    log(`Launching ${command[0]} in tmux...`);
    await tmux.createSessionAsync(tmuxName, cmdLine);

    return { ok: true, handle: tmuxName };
  },

  async kill(handle: string): Promise<void> {
    await tmux.killSessionAsync(handle);
  },

  async status(handle: string): Promise<ExecutorStatus> {
    const alive = await tmux.sessionExistsAsync(handle);
    if (alive) return { state: "running" };
    return { state: "completed", exitCode: 0 };
  },

  async send(handle: string, message: string): Promise<void> {
    await tmux.sendTextAsync(handle, message);
  },

  async capture(handle: string, lines?: number): Promise<string> {
    return tmux.capturePaneAsync(handle, { lines: lines ?? 50 });
  },
};

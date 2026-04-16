/**
 * Subprocess executor -- runs arbitrary commands as child processes.
 *
 * For agent YAML with `runtime: subprocess` and a `command` field.
 * Spawns the command, tracks the process, buffers output.
 */

import type { Executor, LaunchOpts, LaunchResult, ExecutorStatus } from "../executor.js";

interface TrackedProcess {
  proc: ReturnType<typeof Bun.spawn>;
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
  exited: boolean;
}

const processes = new Map<string, TrackedProcess>();

export const subprocessExecutor: Executor = {
  name: "subprocess",

  async launch(opts: LaunchOpts): Promise<LaunchResult> {
    const command = opts.agent.command;
    if (!command || command.length === 0) {
      return { ok: false, handle: "", message: "Agent has no command defined" };
    }

    const handle = `sp-${opts.sessionId}-${Date.now()}`;

    const proc = Bun.spawn(command, {
      cwd: opts.workdir,
      env: { ...process.env, ...opts.env, ...(opts.agent.env ?? {}) },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const tracked: TrackedProcess = {
      proc,
      stdout: [],
      stderr: [],
      exitCode: null,
      exited: false,
    };

    // Stream stdout
    if (proc.stdout) {
      const reader = proc.stdout.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            tracked.stdout.push(new TextDecoder().decode(value));
          }
        } catch {
          // Stream ended or errored -- expected during process exit
        }
      })();
    }

    // Stream stderr
    if (proc.stderr) {
      const reader = proc.stderr.getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            tracked.stderr.push(new TextDecoder().decode(value));
          }
        } catch {
          // Stream ended or errored -- expected during process exit
        }
      })();
    }

    // Track exit
    proc.exited.then((code) => {
      tracked.exitCode = code;
      tracked.exited = true;
      // Auto-cleanup after 5 minutes to prevent memory leaks
      setTimeout(() => { processes.delete(handle); }, 5 * 60 * 1000);
    });

    processes.set(handle, tracked);
    return { ok: true, handle, pid: proc.pid };
  },

  async kill(handle: string): Promise<void> {
    const tracked = processes.get(handle);
    if (!tracked) return;
    if (!tracked.exited) tracked.proc.kill();
    // Clean up after kill
    setTimeout(() => { processes.delete(handle); }, 1000);
  },

  async status(handle: string): Promise<ExecutorStatus> {
    const tracked = processes.get(handle);
    if (!tracked) return { state: "not_found" };
    if (!tracked.exited) return { state: "running", pid: tracked.proc.pid };
    if (tracked.exitCode === 0) return { state: "completed", exitCode: 0 };
    return { state: "failed", error: `Exit code ${tracked.exitCode}` };
  },

  async send(handle: string, message: string): Promise<void> {
    const tracked = processes.get(handle);
    if (!tracked || tracked.exited) return;
    // Bun's stdin is a FileSink -- write directly
    const sink = tracked.proc.stdin;
    if (sink) {
      (sink as { write(data: Uint8Array): number }).write(new TextEncoder().encode(message + "\n"));
      (sink as { flush?(): void }).flush?.();
    }
  },

  async capture(handle: string, lines?: number): Promise<string> {
    const tracked = processes.get(handle);
    if (!tracked) return "";
    const all = [...tracked.stdout, ...tracked.stderr].join("");
    if (!lines) return all;
    const allLines = all.split("\n");
    return allLines.slice(-lines).join("\n");
  },
};

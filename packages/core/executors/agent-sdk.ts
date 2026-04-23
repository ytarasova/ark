/**
 * Agent SDK executor -- spawns the agent-sdk launch process as a plain
 * child process (no tmux). The launch script reads session context from
 * ARK_* env vars, drives the Anthropic Agent SDK query loop, writes
 * transcript.jsonl to <sessionDir>/, and POSTs hooks to the conductor.
 *
 * Key design decisions vs Claude Code executor:
 *   - No tmux pane is created. Process is a plain Bun child process.
 *   - Stdout/stderr are piped to <sessionDir>/stdio.log for debugging only;
 *     the canonical data path is transcript.jsonl + conductor hooks.
 *   - Process is tracked in a module-level Map (keyed by handle) so kill()
 *     can SIGTERM it without needing a tmux session name.
 *   - The handle is `sdk-<sessionId>` (not `ark-<sessionId>`) to make it
 *     immediately clear in logs that this is a subprocess, not a tmux session.
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";

import type { Executor, LaunchOpts, LaunchResult, ExecutorStatus } from "../executor.js";
import { agentSdkLaunchSpec } from "../install-paths.js";
import { formatTranscriptLine } from "../runtimes/agent-sdk/format.js";

interface TrackedSdkProcess {
  proc: ReturnType<typeof Bun.spawn>;
  exitCode: number | null;
  exited: boolean;
  /** Absolute path to the session directory -- used by capture() to read transcript.jsonl + stdio.log. */
  sessionDir: string;
}

// Module-level registry keyed by handle (`sdk-<sessionId>`).
// Each AppContext lifetime is a single Bun process, so module-level state is
// acceptable here (same pattern used by subprocess.ts).
const processes = new Map<string, TrackedSdkProcess>();

/** Pipe a ReadableStream to a file (best-effort; errors are swallowed). */
function pipeToFile(stream: ReadableStream<Uint8Array>, filePath: string): void {
  (async () => {
    try {
      for await (const chunk of stream) {
        appendFileSync(filePath, chunk);
      }
    } catch {
      // Process exited or pipe closed -- expected.
    }
  })();
}

export const agentSdkExecutor: Executor = {
  name: "agent-sdk",

  async launch(opts: LaunchOpts): Promise<LaunchResult> {
    const app = opts.app!;
    const session = await app.sessions.get(opts.sessionId);
    if (!session) {
      return { ok: false, handle: "", message: `Session ${opts.sessionId} not found` };
    }

    // Ensure session directory exists early so the log tee can write to stdio.log
    // before pipeToFile is wired up. We recreate it after worktree setup too, but
    // we need it now to wire the log() tee correctly.
    const sessionDir = join(app.config.tracksDir, session.id);
    mkdirSync(sessionDir, { recursive: true });
    const stdioPath = join(sessionDir, "stdio.log");

    // Build a tee logger: every log() call goes to the upstream callback AND
    // appends to <sessionDir>/stdio.log so it is visible via `ark session output`.
    const log = (msg: string): void => {
      if (opts.onLog) opts.onLog(msg);
      try {
        appendFileSync(stdioPath, `[exec ${new Date().toISOString()}] ${msg}\n`);
      } catch {
        // stdio.log may not be writable yet -- still called upstream log above.
      }
    };

    // Worktree setup
    const compute = session.compute_name ? await app.computes.get(session.compute_name) : null;
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute?.provider ?? "local");
    const { setupSessionWorktree } = await import("../services/worktree/index.js");
    const effectiveWorkdir = await setupSessionWorktree(app, session, compute, provider, log);

    // Ensure session directory exists (sessionDir already created above for log tee)
    // and write task file.
    const promptFile = join(sessionDir, "task.txt");

    // Write the full task (includes handoff context + knowledge injection).
    // opts.task is the fully assembled prompt; opts.initialPrompt is the short
    // summary. The launch script uses the prompt file for the real query.
    const { writeFileSync } = await import("fs");
    writeFileSync(promptFile, opts.task);

    // Assemble ARK_* env vars for the launch process
    const conductorUrl = app.config.conductorUrl;
    const arkEnv: Record<string, string> = {
      ARK_SESSION_ID: session.id,
      ARK_SESSION_DIR: sessionDir,
      ARK_WORKTREE: effectiveWorkdir ?? session.workdir ?? session.repo ?? "",
      ARK_PROMPT_FILE: promptFile,
      ARK_CONDUCTOR_URL: conductorUrl,
    };

    // Optional model override
    const model = opts.agent.model || (session.config?.model_override as string | undefined);
    if (model) arkEnv.ARK_MODEL = model;

    // Optional per-agent knobs (max_turns, etc.)
    const maxTurns = opts.agent.max_turns;
    if (maxTurns && maxTurns > 0) arkEnv.ARK_MAX_TURNS = String(maxTurns);

    // Budget and system prompt append from agent config if set
    const maxBudget = (opts.agent as Record<string, unknown>).max_budget_usd as number | undefined;
    if (maxBudget != null) arkEnv.ARK_MAX_BUDGET_USD = String(maxBudget);

    const systemAppend = (opts.agent as Record<string, unknown>).system_prompt as string | undefined;
    if (systemAppend) arkEnv.ARK_SYSTEM_PROMPT_APPEND = systemAppend;

    // Tenant ID for multi-tenant conductor routing
    if (session.tenant_id) arkEnv.ARK_TENANT_ID = session.tenant_id;

    // Propagate runtime compat modes (e.g. `bedrock`) as a comma-separated
    // ARK_COMPAT env var. launch.ts reads this to enable gateway-specific
    // wire-format rewrites without any heuristic guessing.
    //
    // Lookup is keyed by this executor's name ("agent-sdk") rather than
    // opts.agent.runtime -- the agent definition's runtime field can carry the
    // post-resolution kind ("claude-code" if the agent originally targeted CC
    // and was re-routed via runtime_override), which would point at the wrong
    // runtime YAML. The executor's own name is the authoritative key here.
    const runtimeDef = await app.runtimes?.get?.("agent-sdk");
    const compat = Array.isArray((runtimeDef as { compat?: unknown })?.compat)
      ? (runtimeDef as { compat: string[] }).compat.filter((c) => typeof c === "string" && c.length > 0)
      : [];
    if (compat.length > 0) arkEnv.ARK_COMPAT = compat.join(",");
    log(`agent-sdk compat modes: ${compat.length > 0 ? compat.join(",") : "(none)"}`);

    // opts.env carries secrets resolved by StageSecretResolver
    // (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL per agent-sdk.yaml secrets block)
    // as well as tenant-level claude auth from materializeClaudeAuth.
    // These override all other env sources so operator-rotated values take effect.
    const secretEnv = opts.env ?? {};

    // Resolve the launch command (handles compiled vs dev mode)
    const launchSpec = agentSdkLaunchSpec();
    const cmd = [launchSpec.command, ...launchSpec.args];

    log(`Spawning agent-sdk launch process: ${cmd.join(" ")}`);

    const proc = Bun.spawn({
      cmd,
      cwd: effectiveWorkdir ?? session.workdir ?? session.repo ?? undefined,
      env: { ...process.env, ...arkEnv, ...secretEnv } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });

    const handle = `sdk-${session.id}`;
    const tracked: TrackedSdkProcess = {
      proc,
      exitCode: null,
      exited: false,
      sessionDir,
    };
    processes.set(handle, tracked);

    // Pipe stdout + stderr to <sessionDir>/stdio.log for debugging.
    // Do NOT parse -- transcript.jsonl + conductor hooks are the canonical path.
    // stdioPath is already defined above (used by the log() tee).
    if (proc.stdout) pipeToFile(proc.stdout as ReadableStream<Uint8Array>, stdioPath);
    if (proc.stderr) pipeToFile(proc.stderr as ReadableStream<Uint8Array>, stdioPath);

    // Track exit asynchronously
    proc.exited.then((code) => {
      tracked.exitCode = code;
      tracked.exited = true;
      log(`agent-sdk process (${handle}) exited with code ${code}`);
      // Auto-cleanup after 5 minutes to prevent memory leaks
      setTimeout(
        () => {
          processes.delete(handle);
        },
        5 * 60 * 1000,
      );
    });

    return { ok: true, handle, pid: proc.pid };
  },

  async kill(handle: string): Promise<void> {
    const tracked = processes.get(handle);
    if (!tracked) return;
    if (!tracked.exited) {
      tracked.proc.kill("SIGTERM");
      // Give the process a moment to handle SIGTERM cleanly before returning
      // (the abort controller in launch.ts should abort the SDK query).
      await Bun.sleep(200);
      if (!tracked.exited) {
        tracked.proc.kill("SIGKILL");
      }
    }
    setTimeout(() => {
      processes.delete(handle);
    }, 1000);
  },

  /**
   * Hard-terminate with SIGKILL -- no SIGTERM grace period. Used by
   * `session/kill` which requires immediate termination. Awaits process exit
   * so the caller can rely on the process being gone when this returns.
   */
  async terminate(handle: string): Promise<void> {
    const tracked = processes.get(handle);
    if (!tracked || tracked.exited) return;
    tracked.proc.kill("SIGKILL");
    // Await the actual process exit so the caller sees a clean post-condition.
    await tracked.proc.exited;
    processes.delete(handle);
  },

  async status(handle: string): Promise<ExecutorStatus> {
    const tracked = processes.get(handle);
    if (!tracked) return { state: "not_found" };
    if (!tracked.exited) return { state: "running", pid: tracked.proc.pid };
    if (tracked.exitCode === 0) return { state: "completed", exitCode: 0 };
    return { state: "failed", error: `Exit code ${tracked.exitCode}` };
  },

  async send(_handle: string, _message: string): Promise<void> {
    // The agent-sdk runtime does not accept mid-session input via stdin.
    // All context is delivered via the prompt file before launch.
  },

  async capture(handle: string, lines = 80): Promise<string> {
    const tracked = processes.get(handle);
    // Resolve sessionDir: prefer live tracked entry, fall back to deriving from
    // the handle for sessions that have already exited and been cleaned up.
    // The handle is `sdk-<sessionId>` so we can derive a path if we have a
    // tracksDir, but we don't have access to AppContext here. The tracked entry
    // is always populated during and shortly after the session is running, which
    // covers the primary use case (operator runs `ark session output` while the
    // agent is active or just finished).
    if (!tracked) return "";

    const { sessionDir: sDir } = tracked;
    const transcriptPath = join(sDir, "transcript.jsonl");
    const stdioPath = join(sDir, "stdio.log");

    const formatted: string[] = [];

    if (existsSync(transcriptPath)) {
      const all = readFileSync(transcriptPath, "utf8")
        .split("\n")
        .filter((l) => l.trim());
      for (const line of all.slice(-lines)) {
        formatted.push(formatTranscriptLine(line));
      }
    }

    if (existsSync(stdioPath)) {
      formatted.push("--- stdio ---");
      const stdio = readFileSync(stdioPath, "utf8")
        .split("\n")
        .filter((l) => l.trim());
      for (const line of stdio.slice(-Math.min(lines, 30))) {
        formatted.push(line);
      }
    }

    return formatted.join("\n");
  },
};

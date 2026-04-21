/**
 * OpenCode executor -- native integration for the OpenCode AI coding agent
 * (github.com/opencode-ai/opencode).
 *
 * OpenCode is a terminal-based AI coding agent that accepts tasks via the
 * `-p` flag in non-interactive mode. Model selection and MCP servers are
 * configured through `.opencode.json` in the project directory.
 *
 * Ark dispatches to OpenCode via `opencode -q -p "<task>"` in a tmux
 * session. Key integration points:
 *
 *   - Config injection: Ark writes `.opencode.json` to the worktree with
 *     model config and MCP server entries (channel relay for conductor
 *     communication).
 *   - LLM router: ANTHROPIC_BASE_URL and OPENAI_BASE_URL are injected via
 *     buildRouterEnv so all LLM traffic flows through Ark's router.
 *   - Transcript parsing: OpenCode stores sessions in a SQLite database at
 *     `.opencode/opencode.db`; the opencode TranscriptParser reads it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { recordingPath } from "../recordings.js";

import type { Executor, LaunchOpts, LaunchResult, ExecutorStatus } from "../executor.js";
import * as tmux from "../infra/tmux.js";
import * as claude from "../claude/claude.js";
import { logInfo } from "../observability/structured-log.js";

/** Single-quote a string for safe bash interpolation (no expansion). */
const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

// -- Pure command-line builder (unit-testable) --------------------------------

export interface OpenCodeCommandOpts {
  task: string;
  /** Override the binary path (defaults to "opencode"). */
  binaryPath?: string;
}

/**
 * Build the `opencode` argv for non-interactive dispatch.
 * Pure function -- no side effects -- so the shape can be asserted in tests.
 */
export function buildOpenCodeCommand(opts: OpenCodeCommandOpts): string[] {
  const bin = opts.binaryPath ?? "opencode";
  return [bin, "-q", "-p", opts.task];
}

// -- Config builder (unit-testable) -------------------------------------------

export interface OpenCodeConfigOpts {
  model?: string;
  mcpServers?: Record<string, unknown>;
}

/**
 * Build the `.opencode.json` config object. Merges with an existing config
 * if provided so user settings are preserved.
 */
export function buildOpenCodeConfig(
  opts: OpenCodeConfigOpts,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...(existing ?? {}) };

  if (opts.model) {
    const agents = (config.agents as Record<string, unknown>) ?? {};
    const coder = (agents.coder as Record<string, unknown>) ?? {};
    const task = (agents.task as Record<string, unknown>) ?? {};
    config.agents = {
      ...agents,
      coder: { ...coder, model: opts.model },
      task: { ...task, model: opts.model },
    };
  }

  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
    const existingServers = (config.mcpServers as Record<string, unknown>) ?? {};
    config.mcpServers = { ...existingServers, ...opts.mcpServers };
  }

  return config;
}

// -- Executor -----------------------------------------------------------------

export const opencodeExecutor: Executor = {
  name: "opencode",

  async launch(opts: LaunchOpts): Promise<LaunchResult> {
    const app = opts.app!;
    const log = opts.onLog ?? (() => {});
    const session = app.sessions.get(opts.sessionId);
    if (!session) {
      return { ok: false, handle: "", message: `Session ${opts.sessionId} not found` };
    }

    const stage = opts.stage ?? "work";
    const tmuxName = `ark-${session.id}`;

    // Worktree + compute provider
    const compute = session.compute_name ? app.computes.get(session.compute_name) : null;
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute?.provider ?? "local");
    const { setupSessionWorktree } = await import("../services/session-orchestration.js");
    const effectiveWorkdir = await setupSessionWorktree(app, session, compute, provider, log);

    // Conductor URL (devcontainer vs host)
    const { parseArcJson } = await import("../../compute/arc-json.js");
    const { DEFAULT_CONDUCTOR_URL, DOCKER_CONDUCTOR_URL } = await import("../constants.js");
    const arcJson = effectiveWorkdir ? parseArcJson(effectiveWorkdir) : null;
    const conductorUrl = arcJson?.devcontainer ? DOCKER_CONDUCTOR_URL : DEFAULT_CONDUCTOR_URL;

    // Channel MCP config for conductor communication
    const channelPort = app.sessions.channelPort(session.id);
    const channelCfg = claude.channelMcpConfig(session.id, stage, channelPort, { conductorUrl });

    // Write .opencode.json to the worktree with model + MCP config
    const mcpServers: Record<string, unknown> = {
      "ark-channel": {
        type: "stdio",
        command: channelCfg.command as string,
        args: (channelCfg.args as string[]) ?? [],
        env: (channelCfg.env as Record<string, string>) ?? {},
      },
    };

    let existingConfig: Record<string, unknown> = {};
    const configPath = join(effectiveWorkdir, ".opencode.json");
    if (existsSync(configPath)) {
      try {
        existingConfig = JSON.parse(readFileSync(configPath, "utf-8"));
      } catch {
        logInfo("general", "existing .opencode.json unparseable, overwriting");
      }
    }

    const openCodeConfig = buildOpenCodeConfig({ model: opts.agent.model, mcpServers }, existingConfig);
    writeFileSync(configPath, JSON.stringify(openCodeConfig, null, 2));

    // Build the command argv
    const argv = buildOpenCodeCommand({ task: opts.task });

    // Env: router + channel + agent env merged
    const { buildRouterEnv } = await import("./router-env.js");
    const channelEnv = (channelCfg.env ?? {}) as Record<string, string>;
    const mergedEnv: Record<string, string> = {
      ...channelEnv,
      ...(opts.agent.env ?? {}),
      ...(provider?.buildLaunchEnv?.(session) ?? {}),
      ...(opts.env ?? {}),
      ...buildRouterEnv(app.config, { mode: "openai" }),
    };

    // Write env to a sourced file
    const trackDir = join(app.config.tracksDir, session.id);
    mkdirSync(trackDir, { recursive: true });
    const envFile = join(trackDir, "env.sh");
    const envLines = Object.entries(mergedEnv)
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join("\n");
    writeFileSync(envFile, envLines);
    writeFileSync(join(trackDir, "task.txt"), opts.task);

    // Shell command
    const quotedArgv = argv.map((a) => shellQuote(a)).join(" ");
    const envPrefix = envLines ? `source ${shellQuote(envFile)} && ` : "";
    const cmdLine = `${envPrefix}cd ${shellQuote(effectiveWorkdir)} && ${quotedArgv}`;

    log("Launching opencode in tmux...");
    await tmux.createSessionAsync(tmuxName, cmdLine, { arkDir: app.config.arkDir });
    const rootPid = await tmux.getPanePidAsync(tmuxName);

    // Start recording terminal output for post-session replay
    const recPath = recordingPath(app.config.arkDir, session.id);
    mkdirSync(join(app.config.arkDir, "recordings"), { recursive: true });
    await tmux.pipePaneAsync(tmuxName, recPath);

    return { ok: true, handle: tmuxName, pid: rootPid ?? undefined };
  },

  async kill(handle: string): Promise<void> {
    await tmux.killSessionAsync(handle);
  },

  async status(handle: string): Promise<ExecutorStatus> {
    const alive = await tmux.sessionExistsAsync(handle);
    return alive ? { state: "running" } : { state: "not_found" };
  },

  async send(handle: string, message: string): Promise<void> {
    await tmux.sendTextAsync(handle, message);
  },

  async capture(handle: string, lines?: number): Promise<string> {
    return tmux.capturePaneAsync(handle, { lines: lines ?? 50 });
  },
};

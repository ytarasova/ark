/**
 * Goose executor -- native integration for Block / Linux Foundation AAIF's
 * Goose AI agent (github.com/block/goose).
 *
 * Ark dispatches to Goose via `goose run` in a tmux session. Goose's native
 * features that we wire up:
 *
 *   - Recipe dispatch: `--recipe <file>` + `--sub-recipe <file>` + `--params k=v`
 *     (or fall back to `-t "<task>"` for plain text delivery when no recipe)
 *   - MCP channel: Ark's conductor channel is passed to goose as a stdio
 *     extension via `--with-extension "<cmd> <args>"`. Goose spawns it as a
 *     subprocess that inherits our env (ARK_SESSION_ID / ARK_CHANNEL_PORT /
 *     ARK_CONDUCTOR_URL), so the extension reaches the same conductor path
 *     claude-code uses.
 *   - LLM router: we inject ANTHROPIC_BASE_URL and OPENAI_BASE_URL via
 *     buildRouterEnv (mode: openai) so whichever provider goose selects goes
 *     through Ark's router + TensorZero stack.
 *   - Model pinning: `--model <agent.model>` lets the agent YAML pick the
 *     model without touching goose config.
 *   - Stateless: `--no-session` disables goose's own session store so Ark
 *     owns all session state.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { recordingPath } from "../recordings.js";

import type { Executor, LaunchOpts, LaunchResult, ExecutorStatus } from "../executor.js";
import * as tmux from "../infra/tmux.js";
import * as claude from "../claude/claude.js";
import { findCodebaseMemoryBinary } from "../knowledge/codebase-memory-finder.js";
import { existsSync } from "fs";

/** Single-quote a string for safe bash interpolation (no expansion). */
const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

// ── Pure command-line builder (unit-testable) ──────────────────────────────

export interface GooseCommandOpts {
  agent: LaunchOpts["agent"];
  task: string;
  sessionId: string;
  /** Channel MCP config from claude.channelMcpConfig() -- we translate to --with-extension. */
  channelExtension?: { command: string; args: string[] };
  /** Template parameters passed as --params k=v to the recipe. */
  params?: Record<string, string>;
  /** Default to `goose`, override for bundled binary paths in tests. */
  binaryPath?: string;
  /** When true, pass `-s` so goose stays alive after delivering the task (manual gate). */
  interactive?: boolean;
}

/**
 * Build the `goose run` argv. Pure function -- no side effects -- so the
 * shape can be asserted in unit tests without spawning anything.
 */
export function buildGooseCommand(opts: GooseCommandOpts): string[] {
  const bin = opts.binaryPath ?? "goose";
  const args: string[] = [bin, "run", "--no-session"];

  if (opts.agent.model) {
    args.push("--model", opts.agent.model);
  }
  if (opts.agent.max_turns && opts.agent.max_turns > 0) {
    args.push("--max-turns", String(opts.agent.max_turns));
  }

  if (opts.channelExtension) {
    const extCmd = [opts.channelExtension.command, ...opts.channelExtension.args].join(" ");
    args.push("--with-extension", extCmd);
  }

  // Inject codebase-memory-mcp as a second extension when the vendored
  // binary is available. Gives goose the same 14 code-intelligence tools
  // Claude Code gets via .mcp.json. Upstream auto-detects Claude/Codex/Gemini/etc
  // but not Goose, so we wire it manually (consistent with channel extension).
  const cbmBin = findCodebaseMemoryBinary();
  if (cbmBin !== "codebase-memory-mcp" && existsSync(cbmBin)) {
    args.push("--with-extension", cbmBin);
  }

  // Interactive mode: -s keeps goose alive after task delivery (manual gate).
  if (opts.interactive) {
    args.push("-s");
  }

  // Recipe delivery takes precedence over text delivery
  if (opts.agent.recipe) {
    args.push("--recipe", opts.agent.recipe);
    for (const subRecipe of opts.agent.sub_recipes ?? []) {
      args.push("--sub-recipe", subRecipe);
    }
    for (const [k, v] of Object.entries(opts.params ?? {})) {
      args.push("--params", `${k}=${v}`);
    }
  } else {
    // Text delivery: pass the task directly as --text
    args.push("-t", opts.task);
  }

  return args;
}

// ── Executor ───────────────────────────────────────────────────────────────

export const gooseExecutor: Executor = {
  name: "goose",

  async launch(opts: LaunchOpts): Promise<LaunchResult> {
    const app = opts.app!;
    const log = opts.onLog ?? (() => {});
    const session = await app.sessions.get(opts.sessionId);
    if (!session) {
      return { ok: false, handle: "", message: `Session ${opts.sessionId} not found` };
    }

    const stage = opts.stage ?? "work";
    const tmuxName = `ark-${session.id}`;

    // Worktree + compute provider
    const compute = session.compute_name ? await app.computes.get(session.compute_name) : null;
    const { getProvider } = await import("../../compute/index.js");
    const provider = getProvider(compute?.provider ?? "local");
    const { setupSessionWorktree } = await import("../services/workspace-service.js");
    const effectiveWorkdir = await setupSessionWorktree(app, session, compute, provider, log);

    // Conductor URL (devcontainer vs host)
    const { parseArcJson } = await import("../../compute/arc-json.js");
    const { DEFAULT_CONDUCTOR_URL, DOCKER_CONDUCTOR_URL } = await import("../constants.js");
    const arcJson = effectiveWorkdir ? parseArcJson(effectiveWorkdir) : null;
    const conductorUrl = arcJson?.devcontainer ? DOCKER_CONDUCTOR_URL : DEFAULT_CONDUCTOR_URL;

    // Channel MCP -- reuse the same config builder claude uses. Goose will
    // spawn the `command + args` as a stdio extension and inherit our env.
    const channelPort = app.sessions.channelPort(session.id);
    const channelCfg = claude.channelMcpConfig(session.id, stage, channelPort, { conductorUrl });

    // Recipe params: pull session template vars so recipe authors can use
    // `{{ticket}}`, `{{summary}}`, `{{workdir}}`, etc. User-supplied
    // `session.config.inputs.params` overlays on top so dispatch-form values
    // (e.g. `--param jira_key=IN-1234`) reach the recipe.
    const sessionInputs = (session.config as Record<string, unknown> | undefined)?.inputs as
      | { params?: Record<string, string> }
      | undefined;
    const recipeParams: Record<string, string> = {
      ticket: session.ticket ?? "",
      summary: session.summary ?? "",
      workdir: effectiveWorkdir,
      repo: session.repo ?? "",
      branch: session.branch ?? "",
      ...(sessionInputs?.params ?? {}),
    };

    // Build the goose command argv
    // Interactive mode (-s): keep goose alive when autonomy is not "full" (manual gate).
    const interactive = opts.autonomy !== undefined && opts.autonomy !== "full";
    const argv = buildGooseCommand({
      agent: opts.agent,
      task: opts.task,
      sessionId: session.id,
      channelExtension: {
        command: channelCfg.command as string,
        args: (channelCfg.args as string[]) ?? [],
      },
      params: recipeParams,
      interactive,
    });

    // Env: router + channel + agent env merged. Router injects
    // ANTHROPIC_BASE_URL and OPENAI_BASE_URL so whichever provider goose
    // picks flows through our router + TensorZero.
    const { buildRouterEnv } = await import("./router-env.js");
    const channelEnv = (channelCfg.env ?? {}) as Record<string, string>;
    const mergedEnv: Record<string, string> = {
      ...channelEnv,
      ...(opts.agent.env ?? {}),
      ...(provider?.buildLaunchEnv?.(session) ?? {}),
      ...(opts.env ?? {}),
      ...buildRouterEnv(app.config, { mode: "openai" }),
    };

    // Write env to a sourced file (avoids shell-quoting user values)
    const trackDir = join(app.config.tracksDir, session.id);
    mkdirSync(trackDir, { recursive: true });
    const envFile = join(trackDir, "env.sh");
    const envLines = Object.entries(mergedEnv)
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join("\n");
    writeFileSync(envFile, envLines);
    writeFileSync(join(trackDir, "task.txt"), opts.task);

    // Shell-quote the argv for a single bash line. Use single quotes to
    // prevent bash from expanding backticks / $() in the task text.
    const quotedArgv = argv.map((a) => shellQuote(a)).join(" ");
    const envPrefix = envLines ? `source ${shellQuote(envFile)} && ` : "";
    const cmdLine = `${envPrefix}cd ${shellQuote(effectiveWorkdir)} && ${quotedArgv}`;

    log("Launching goose in tmux...");
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

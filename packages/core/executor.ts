/**
 * Executor abstraction -- pluggable agent runtime interface.
 *
 * Decouples session dispatch from Claude Code. Each executor
 * implements launch/kill/status/send/capture for a specific runtime.
 */

export interface LaunchOpts {
  sessionId: string;
  workdir: string;
  agent: {
    name: string;
    model: string;
    max_turns: number;
    system_prompt: string;
    tools: string[];
    skills: string[];
    mcp_servers: (string | Record<string, unknown>)[];
    permission_mode: string;
    env: Record<string, string>;
    command?: string[];
    /** Runtime kind (claude-code | goose | codex | gemini | cli-agent). */
    runtime?: string;
    /** Resolved runtime kind from RuntimeStore merge (mirrors AgentDefinition). */
    _resolved_runtime_type?: string;
    /** Optional goose recipe path (native YAML), handled by gooseExecutor. */
    recipe?: string;
    /** Optional goose sub-recipe paths, handled by gooseExecutor. */
    sub_recipes?: string[];
  };
  task: string;
  claudeArgs?: string[];
  env?: Record<string, string>;
  compute?: { name: string; provider: string; [k: string]: unknown };
  stage?: string;
  autonomy?: string;
  onLog?: (msg: string) => void;
  prevClaudeSessionId?: string | null;
  sessionName?: string;
  /** Initial prompt to pass as positional arg for immediate processing. */
  initialPrompt?: string;
  /**
   * PlacementCtx forwarded from dispatch's pre-launch placement pass. The
   * executor passes this through to `provider.launch()` on `LaunchOpts.placement`
   * so remote-medium providers (EC2 over SSM, ...) can flush queued file ops
   * post-provision. Opaque to executors -- they neither read nor mutate it.
   */
  placement?: import("./secrets/placement-types.js").PlacementCtx;
  /** AppContext passed from dispatch -- avoids getApp() in executors. */
  app?: import("./app.js").AppContext;
}

export interface LaunchResult {
  ok: boolean;
  handle: string;
  message?: string;
  claudeSessionId?: string | null;
  pid?: number;
}

export interface ProcessInfo {
  rootPid: number;
  children: Array<{
    pid: number;
    ppid: number;
    command: string;
    cpu?: number;
    mem?: number;
  }>;
  capturedAt: string;
}

export type ExecutorStatus =
  | { state: "running"; pid?: number }
  | { state: "idle" }
  | { state: "completed"; exitCode?: number }
  | { state: "failed"; error: string }
  | { state: "not_found" };

/**
 * Context passed to `Executor.sendUserMessage`. Each runtime owns the strategy
 * for getting a user message into its agent loop:
 *   - claude-agent: arkd `/channel/user-input/publish` (wire) -> PromptQueue
 *   - claude-code: tmux send-keys to the agent's pane (paste-buffer + Enter)
 *   - goose / cli-agent / subprocess: stdin or tmux per their delivery mode
 *
 * The Executor sees app + session + compute, so it can resolve the right
 * provider, port, and worker -- the conductor doesn't need to know which
 * transport applies to which runtime.
 */
export interface SendUserMessageOpts {
  app: import("./app.js").AppContext;
  session: import("../types/session.js").Session;
  message: string;
}

export interface SendUserMessageResult {
  ok: boolean;
  /** Human-readable status -- shown in the UI when ok=false. */
  message: string;
}

export interface Executor {
  name: string;
  launch(opts: LaunchOpts): Promise<LaunchResult>;
  kill(handle: string): Promise<void>;
  /**
   * Hard-terminate a tracked process with SIGKILL -- no grace period.
   * Optional: executors that don't implement it fall back to `kill(handle)`.
   */
  terminate?(handle: string): Promise<void>;
  status(handle: string): Promise<ExecutorStatus>;
  /**
   * Legacy lower-level send: writes to the underlying handle (tmux pane name
   * for tmux-based executors, ignored by claude-agent which has no stdin
   * surface). Kept for callers that already have a handle and don't need
   * the runtime-aware path.
   */
  send(handle: string, message: string): Promise<void>;
  /**
   * Runtime-polymorphic send. The conductor's session.send() delegates here;
   * each executor implements the right transport for its runtime. Optional
   * so legacy executors that only support handle-based send still work via
   * the default delegate in `services/session-output.ts:send`.
   */
  sendUserMessage?(opts: SendUserMessageOpts): Promise<SendUserMessageResult>;
  capture(handle: string, lines?: number): Promise<string>;
}

// ── Registry ────────────────────────────────────────────────────────────────

const registry = new Map<string, Executor>();

/**
 * Backward-compat aliases for the May 2026 runtime rename. Sessions persisted
 * before the rename store `launch_executor: "agent-sdk"`; redirect to the
 * post-rename name so dispatch keeps working without a data migration.
 */
const EXECUTOR_NAME_ALIASES: Record<string, string> = {
  "agent-sdk": "claude-agent",
};

export function registerExecutor(executor: Executor): void {
  registry.set(executor.name, executor);
}

export function getExecutor(name: string): Executor | undefined {
  const resolved = EXECUTOR_NAME_ALIASES[name] ?? name;
  return registry.get(resolved);
}

export function listExecutors(): Executor[] {
  return Array.from(registry.values());
}

export function resetExecutors(): void {
  registry.clear();
}

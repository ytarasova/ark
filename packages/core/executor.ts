/**
 * Executor abstraction — pluggable agent runtime interface.
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
  /** AppContext passed from dispatch -- avoids getApp() in executors. */
  app?: import("./app.js").AppContext;
}

export interface LaunchResult {
  ok: boolean;
  handle: string;
  message?: string;
  claudeSessionId?: string | null;
}

export type ExecutorStatus =
  | { state: "running"; pid?: number }
  | { state: "idle" }
  | { state: "completed"; exitCode?: number }
  | { state: "failed"; error: string }
  | { state: "not_found" };

export interface Executor {
  name: string;
  launch(opts: LaunchOpts): Promise<LaunchResult>;
  kill(handle: string): Promise<void>;
  status(handle: string): Promise<ExecutorStatus>;
  send(handle: string, message: string): Promise<void>;
  capture(handle: string, lines?: number): Promise<string>;
}

// ── Registry ────────────────────────────────────────────────────────────────

const registry = new Map<string, Executor>();

export function registerExecutor(executor: Executor): void {
  registry.set(executor.name, executor);
}

export function getExecutor(name: string): Executor | undefined {
  return registry.get(name);
}

export function listExecutors(): Executor[] {
  return Array.from(registry.values());
}

export function resetExecutors(): void {
  registry.clear();
}

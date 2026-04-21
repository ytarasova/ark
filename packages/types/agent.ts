export interface SkillDefinition {
  name: string;
  description: string;
  prompt: string;
  tags?: string[];
  _source?: "builtin" | "project" | "global";
}

export interface RuntimeBilling {
  /** 'api' = per-token API pricing, 'subscription' = flat-rate plan, 'free' = no cost */
  mode: "api" | "subscription" | "free";
  /** Subscription plan name (e.g. 'claude-max-200', 'chatgpt-plus') -- for subscription mode */
  plan?: string;
  /** Fixed monthly cost in USD for this subscription */
  cost_per_month?: number;
  /** Transcript parser to use: 'claude' | 'codex' | 'gemini' | 'goose' | 'opencode' (defaults based on type) */
  transcript_parser?: "claude" | "codex" | "gemini" | "goose" | "opencode";
}

export interface RuntimeDefinition {
  name: string;
  description?: string;
  type: "claude-code" | "cli-agent" | "subprocess" | "goose" | "opencode";
  command?: string[];
  task_delivery?: "stdin" | "file" | "arg";
  models?: Array<{ id: string; label: string }>;
  default_model?: string;
  permission_mode?: string;
  env?: Record<string, string>;
  /**
   * MCP servers that should be merged into every session run on this runtime.
   * Each entry can be:
   *   - a string referencing an `mcp-configs/<name>.json` file (loaded at dispatch)
   *   - an inline `{ "<name>": { command, args, env } }` object
   *   - an inline `{ "<name>": { type: "url", url: "..." } }` object for HTTP MCP servers
   * Server-level `${ENV}` placeholders inside the config get expanded against
   * `process.env` so deployments can swap URLs / tokens without editing YAML.
   */
  mcp_servers?: (string | Record<string, unknown>)[];
  /** Billing and cost tracking config. When omitted, defaults to { mode: 'api' }. */
  billing?: RuntimeBilling;
  _source?: "builtin" | "global" | "project";
  _path?: string;
}

export interface AgentDefinition {
  name: string;
  description: string;
  model: string;
  max_turns: number;
  system_prompt: string;
  tools: string[];
  mcp_servers: (string | Record<string, unknown>)[];
  skills: string[];
  memories: string[];
  context: string[];
  permission_mode: string;
  env: Record<string, string>;
  runtime?: string;
  command?: string[];
  task_delivery?: "stdin" | "file" | "arg";
  /**
   * Optional Goose recipe file path (native Goose YAML). When set, the goose
   * executor dispatches `goose run --recipe <path> --params k=v` instead of
   * text delivery. Path is resolved relative to the agent's workdir.
   */
  recipe?: string;
  /**
   * Optional list of Goose sub-recipe paths. Passed as `--sub-recipe <path>`
   * flags alongside the main recipe. Only meaningful when `recipe` is set.
   */
  sub_recipes?: string[];
  _source?: "builtin" | "global" | "project";
  _path?: string;
}

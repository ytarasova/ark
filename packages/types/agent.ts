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
  /** Transcript parser to use: 'claude' | 'codex' | 'gemini' | 'goose' (defaults based on type) */
  transcript_parser?: "claude" | "codex" | "gemini" | "goose";
}

export interface RuntimeDefinition {
  name: string;
  description?: string;
  type: "claude-code" | "cli-agent" | "subprocess" | "goose" | "agent-sdk";
  command?: string[];
  task_delivery?: "stdin" | "file" | "arg";
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
  /**
   * Names of secrets to resolve (via `app.secrets`) and inject as env vars
   * into every session that uses this runtime. Secret names follow the
   * `[A-Z0-9_]+` regex and land verbatim as env vars inside the executor.
   * Missing secrets fail the dispatch. Merged with stage-level secrets;
   * stage wins on conflict.
   */
  secrets?: string[];
  /**
   * Free-text completion instructions appended to every task prompt built for
   * this runtime. Each runtime owns its own "how do you finish?" semantics
   * (e.g. claude: call report(completed); agent-sdk: stop with a final
   * assistant message). Rendered verbatim; Nunjucks substitution applies.
   * When omitted, no completion ritual is appended.
   */
  task_prompt?: string;
  /**
   * Gateway wire-format compatibility modes (e.g. `bedrock`). Opt-in; the
   * runtime launcher reads this to enable wire-format rewrites for gateways
   * that need them. Model resolution does NOT depend on these flags -- models
   * carry their own per-provider slugs in the catalog.
   */
  compat?: string[];
  /**
   * Override the bundled claude binary's default haiku model id for built-in
   * subagents (Explore etc.) that the SDK ships with. Built-in subagents
   * cannot be reconfigured via the SDK's `agents` option, but the bundled
   * binary honours `ANTHROPIC_DEFAULT_HAIKU_MODEL`. Set this when routing
   * through a gateway whose haiku slug differs from the SDK default
   * `claude-haiku-4-5-20251001` (e.g. TF/Bedrock typically wants
   * `pi-agentic/global.anthropic.claude-haiku-4-5`). Only relevant for the
   * `agent-sdk` runtime; ignored elsewhere. Opt-in -- leaving it unset
   * preserves the SDK's hardcoded default for users on Anthropic-direct.
   */
  default_haiku_model?: string;
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

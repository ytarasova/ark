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
  type: "claude-code" | "cli-agent" | "subprocess" | "goose" | "claude-agent";
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
   * Per-runtime-type configuration block. Keys are runtime types
   * (`claude-agent`, `goose`, `claude-code`, ...). Each runtime's executor
   * reads ONLY its own entry. Lives here -- not as top-level fields on
   * `RuntimeDefinition` -- so adding a runtime-specific knob never requires
   * editing the core types module. Examples:
   *
   *   runtime_config:
   *     claude-agent:
   *       default_haiku_model: pi-agentic/global.anthropic.claude-haiku-4-5
   */
  runtime_config?: Record<string, Record<string, unknown>>;
  /**
   * Whether sessions on this runtime can be attached to interactively
   * (xterm.js Terminal tab + `ark session attach <id>`).
   *
   * Runtimes that launch the agent in a tmux pane with a real PTY
   * (claude-code, codex, gemini, goose) get an interactive shell the
   * user can drop into.
   *
   * Runtimes that spawn a plain process via arkd `/process/spawn`
   * (claude-agent, future cli-agent variants) have NO PTY -- the
   * "Terminal" tab can only show static stdio.log tails. Setting
   * `interactive: false` makes ark return `attachable: false` from
   * `session/attach-command` with a clear "live output is in
   * Conversation/Logs tabs" message instead of the WS reconnect-loop.
   *
   * Default: `true` (preserves existing behaviour for the four
   * tmux-based runtimes; only the agent-sdk family declares `false`).
   */
  interactive?: boolean;
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
   * Per-runtime-type configuration block. Keys are runtime types (`goose`,
   * `claude-code`, `claude-agent`, ...). Each runtime's executor reads ONLY
   * its own entry. Lives here -- not as top-level fields on
   * `AgentDefinition` -- so adding a runtime-specific knob never requires
   * editing the core types module. Examples:
   *
   *   runtime_config:
   *     goose:
   *       recipe: "{inputs.files.recipe}"
   *       sub_recipes: ["{inputs.files.sub_recipe}"]
   */
  runtime_config?: Record<string, Record<string, unknown>>;
  _source?: "builtin" | "global" | "project";
  _path?: string;
}

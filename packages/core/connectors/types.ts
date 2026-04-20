/**
 * Connector framework -- outbound capability for an integration.
 *
 * Every external system Ark talks TO ships its outbound surface as a
 * Connector. There are three flavours:
 *
 *   - "mcp"     : the connector mounts an MCP server (file or inline) into
 *                 the agent's session. Same merge path as runtime-level
 *                 mcp_servers (see packages/core/claude/claude.ts and
 *                 packages/core/services/agent-launcher.ts).
 *   - "rest"    : a thin REST adapter (no agent-side tool surface). Used by
 *                 server-side code -- not yet plumbed into agents.
 *   - "context" : a connector that contributes prefill text to the session
 *                 context (`build()` returns markdown the dispatcher injects).
 *
 * Opt-in lives at three levels (highest precedence first):
 *   1. Flow YAML: `connectors: [pi-sage, jira]` -- every stage in the flow
 *      inherits these connectors. Resolved at session start.
 *   2. Session-level: `ark session start --with-mcp pi-sage` (already
 *      shipped) routes through the same MCP merge path.
 *   3. Runtime YAML: `mcp_servers: [...]` (already shipped) -- runtime-level
 *      MCP servers are still inherited by every session on that runtime.
 */

import type { AppContext } from "../app.js";

export type ConnectorKind = "mcp" | "rest" | "context";

/**
 * Reference to an authentication descriptor. Today the registry resolves
 * this against env vars / `~/.ark/secrets.yaml` (mirror of the trigger
 * secrets layer). Future extension: pull from the API key manager.
 */
export interface AuthRef {
  /**
   * Logical auth strategy for the connector. `env` reads from process env;
   * `secrets-file` reads from `<arkDir>/secrets.yaml`; `none` means no auth.
   */
  kind: "none" | "env" | "secrets-file";
  /** For `env`: the env var name. */
  envVar?: string;
  /** For `secrets-file`: dotted path under `connectors.<name>`. */
  secretsKey?: string;
}

export interface ConnectorMcpConfig {
  /**
   * Name of a shipped `mcp-configs/<configName>.json`. Resolved through
   * `resolveMcpConfigsDir()` and merged via `writeChannelConfig()`.
   */
  configName?: string;
  /**
   * Inline `{ "<server-name>": { command, args, env } | { type, url } }`.
   * Skipped if `configName` is set.
   */
  inline?: Record<string, unknown>;
}

export interface ConnectorRestConfig {
  baseUrl: string;
  auth?: AuthRef;
  /** Name -> path (relative to baseUrl). Documentation only -- not invoked. */
  endpoints?: Record<string, string>;
}

export interface ConnectorContextConfig {
  /**
   * Build prefill text (markdown) injected into the session context. Receives
   * the AppContext + the session-create options so it can read inputs.
   */
  build: (ctx: { app: AppContext; sessionOpts: Record<string, unknown> }) => Promise<string>;
}

export interface Connector {
  /** Unique connector name -- maps 1:1 to `connectors:` entries in flows. */
  name: string;
  kind: ConnectorKind;
  /** Maturity. Same enum as TriggerSource for consistency. */
  status: "full" | "scaffolded" | "stub";
  /** Human-readable label. */
  label: string;
  /** Optional connector-level auth descriptor. */
  auth?: AuthRef;
  /** For kind="mcp" connectors. */
  mcp?: ConnectorMcpConfig;
  /** For kind="rest" connectors. */
  rest?: ConnectorRestConfig;
  /** For kind="context" connectors. */
  context?: ConnectorContextConfig;
}

/** A resolved MCP server entry produced by a connector for the dispatch merge. */
export interface ConnectorMcpEntry {
  /** Either the bare connector name (looked up in mcpConfigsDir) or an inline object. */
  entry: string | Record<string, unknown>;
  /** Source connector for diagnostics. */
  fromConnector: string;
}

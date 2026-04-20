/**
 * Connector resolution helpers.
 *
 * Bridges between FlowDefinition.connectors[] and the MCP merge that runs
 * inside `writeChannelConfig` (packages/core/claude/claude.ts).
 *
 * Used by:
 *   - packages/core/executors/claude-code.ts (claude executor path)
 *   - packages/core/services/agent-launcher.ts (legacy tmux launcher path)
 *
 * The merge precedence is: existing .mcp.json > runtime mcp_servers >
 * flow connectors > inline (ark-channel always overwrites). Flow connectors
 * are appended AFTER runtime entries, so a runtime can pre-claim a slot
 * (and a flow can NOT clobber it). This matches the existing
 * `writeChannelConfig` behaviour: "do not override entries already present".
 */

import type { AppContext } from "../app.js";
import type { Session } from "../../types/index.js";
import { createDefaultConnectorRegistry, type ConnectorRegistry } from "./registry.js";

const cache = new WeakMap<AppContext, ConnectorRegistry>();

/** Per-AppContext registry. Same lifecycle as the trigger source registry. */
export function getConnectorRegistry(app: AppContext): ConnectorRegistry {
  let reg = cache.get(app);
  if (!reg) {
    reg = createDefaultConnectorRegistry();
    cache.set(app, reg);
  }
  return reg;
}

/** Test hook: replace the registry stored on an app. */
export function setConnectorRegistry(app: AppContext, registry: ConnectorRegistry): void {
  cache.set(app, registry);
}

/**
 * Gather MCP-server entries (in the same shape `writeChannelConfig` expects)
 * from runtime YAML + flow connectors + per-session `--with-mcp` opt-ins.
 *
 * Returns the merged array suitable for passing as `runtimeMcpServers` to
 * `writeChannelConfig`. The naming is historical -- it covers every opt-in
 * level above the agent YAML.
 */
export function collectMcpEntries(
  app: AppContext,
  session: Session,
  opts: {
    runtimeName?: string;
    /** Connectors declared on the active flow YAML. */
    flowConnectors?: string[];
    /** Per-session connectors -- typically derived from `--with-mcp` flags. */
    sessionConnectors?: string[];
  },
): (string | Record<string, unknown>)[] {
  const out: (string | Record<string, unknown>)[] = [];
  if (opts.runtimeName) {
    const runtime = app.runtimes.get(opts.runtimeName);
    for (const entry of runtime?.mcp_servers ?? []) out.push(entry);
  }
  if (opts.flowConnectors?.length || opts.sessionConnectors?.length) {
    const reg = getConnectorRegistry(app);
    const names = [...(opts.flowConnectors ?? []), ...(opts.sessionConnectors ?? [])];
    for (const e of reg.resolveMcpEntries(names)) out.push(e.entry);
  }
  // Persist applied connectors on the session config for diagnostics +
  // resume paths. We don't fail if `app.sessions` is unavailable -- this is
  // best-effort observability.
  try {
    const applied = (opts.flowConnectors ?? []).concat(opts.sessionConnectors ?? []);
    if (applied.length) {
      const cfg = (session.config ?? {}) as Record<string, unknown>;
      const next = { ...cfg, applied_connectors: applied };
      app.sessions.update(session.id, { config: next });
    }
  } catch {
    /* observability only */
  }
  return out;
}

/**
 * Read the connector list from a session's flow YAML. Returns an empty
 * array when the flow is unknown or has no connectors block.
 */
export function flowConnectorsFor(app: AppContext, flowName: string | undefined): string[] {
  if (!flowName) return [];
  try {
    const flow = app.flows.get(flowName) as { connectors?: string[] } | null;
    return flow?.connectors ?? [];
  } catch {
    return [];
  }
}

/**
 * Connector registry -- per-AppContext lookup of named connectors.
 *
 * Class-based to mirror TriggerSourceRegistry. `createDefaultRegistry()`
 * seeds with every shipped connector definition under `./definitions/`.
 */

import type { Connector, ConnectorMcpEntry } from "./types.js";
import { piSageConnector } from "./definitions/pi-sage.js";
import { jiraConnector } from "./definitions/jira.js";
import { githubConnector } from "./definitions/github.js";
import { linearConnector } from "./definitions/linear.js";
import { bitbucketConnector } from "./definitions/bitbucket.js";
import { slackConnector } from "./definitions/slack.js";

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  register(c: Connector): void {
    this.connectors.set(c.name, c);
  }

  get(name: string): Connector | null {
    return this.connectors.get(name) ?? null;
  }

  list(): Connector[] {
    return [...this.connectors.values()];
  }

  /**
   * Resolve a list of connector names into MCP-style entries that the
   * existing `writeChannelConfig` merge path accepts. Connectors that are
   * not MCP-backed contribute nothing here -- callers should call
   * `resolveContextConnectors` for the context-build path.
   */
  resolveMcpEntries(names: string[]): ConnectorMcpEntry[] {
    const out: ConnectorMcpEntry[] = [];
    for (const name of names) {
      const c = this.get(name);
      if (!c || c.kind !== "mcp" || !c.mcp) continue;
      // Prefer configName (lookup in shipped mcp-configs) -- fall back to inline.
      if (c.mcp.configName) {
        out.push({ entry: c.mcp.configName, fromConnector: c.name });
      } else if (c.mcp.inline) {
        out.push({ entry: c.mcp.inline, fromConnector: c.name });
      }
    }
    return out;
  }

  /**
   * Filter connector names down to those that contribute prefill context
   * (kind="context"). The dispatcher / launcher stitches their build()
   * outputs into the session task. Returns the connector handles directly
   * so the caller can invoke `build` with its own AppContext + opts.
   */
  resolveContextConnectors(names: string[]): Connector[] {
    const out: Connector[] = [];
    for (const name of names) {
      const c = this.get(name);
      if (c?.kind === "context") out.push(c);
    }
    return out;
  }
}

export function createDefaultConnectorRegistry(): ConnectorRegistry {
  const r = new ConnectorRegistry();
  for (const c of builtinConnectors()) r.register(c);
  return r;
}

export function builtinConnectors(): Connector[] {
  return [piSageConnector, jiraConnector, githubConnector, linearConnector, bitbucketConnector, slackConnector];
}

/**
 * JSON-RPC handlers for the connector registry.
 *
 * Methods:
 *   connectors/list  -> list every registered connector
 *   connectors/get   -> fetch one by name
 *   connectors/test  -> dry-run reachability probe (no side effects)
 *
 * The connector registry is the outbound half of the integrations framework
 * (see packages/core/connectors/). For `mcp` connectors the "test" probe
 * checks whether the referenced `mcp-configs/<name>.json` is present on
 * disk (full connectors) or whether the inline config declares a command
 * (scaffolded connectors). For `rest` / `context` connectors the probe
 * simply reports the configured shape without executing anything.
 *
 * Reachability is reported as a boolean plus a short `details` string so
 * the Web UI can surface a meaningful hint when a connector is misconfigured.
 */

import { existsSync } from "fs";
import { join } from "path";
import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { RpcError, ErrorCodes } from "../../protocol/types.js";
import { getConnectorRegistry } from "../../core/connectors/resolve.js";
import type { Connector } from "../../core/connectors/index.js";
import { resolveMcpConfigsDir } from "../../core/install-paths.js";

interface ConnectorView {
  name: string;
  label: string;
  kind: Connector["kind"];
  status: Connector["status"];
  auth: { kind: string; envVar?: string; secretsKey?: string } | null;
  mcp: { configName?: string; configPath?: string | null; hasInline: boolean } | null;
  rest: { baseUrl?: string; endpoints?: string[] } | null;
  hasContext: boolean;
}

/**
 * Serialise a connector to a JSON-safe shape for the UI. We avoid leaking
 * the live `build` callback (context connectors) and compute the shipped
 * mcp-configs path so the UI can show it alongside the kind.
 */
function view(c: Connector, mcpDir: string): ConnectorView {
  const configName = c.mcp?.configName;
  const configPath = configName ? join(mcpDir, `${configName}.json`) : null;
  return {
    name: c.name,
    label: c.label,
    kind: c.kind,
    status: c.status,
    auth: c.auth ? { kind: c.auth.kind, envVar: c.auth.envVar, secretsKey: c.auth.secretsKey } : null,
    mcp: c.mcp
      ? {
          configName,
          configPath: configPath && existsSync(configPath) ? configPath : null,
          hasInline: !!c.mcp.inline,
        }
      : null,
    rest: c.rest ? { baseUrl: c.rest.baseUrl, endpoints: Object.keys(c.rest.endpoints ?? {}) } : null,
    hasContext: c.kind === "context",
  };
}

/**
 * Non-invasive reachability probe. For `mcp` connectors we check the shipped
 * config file is on disk (full) or that the inline entry has a command
 * (scaffolded). For `rest` connectors we report the configured base URL.
 * We never issue network calls from a list/test handler.
 */
function probe(c: Connector, mcpDir: string): { reachable: boolean; details: string } {
  if (c.kind === "mcp") {
    if (c.mcp?.configName) {
      const path = join(mcpDir, `${c.mcp.configName}.json`);
      if (existsSync(path)) return { reachable: true, details: `mcp-config on disk: ${path}` };
      return { reachable: false, details: `missing mcp-config: ${path}` };
    }
    if (c.mcp?.inline) {
      const servers = Object.keys(c.mcp.inline);
      if (servers.length === 0) return { reachable: false, details: "inline MCP object is empty" };
      return { reachable: true, details: `inline MCP server(s): ${servers.join(", ")}` };
    }
    return { reachable: false, details: "no MCP configName or inline config" };
  }
  if (c.kind === "rest") {
    if (c.rest?.baseUrl) return { reachable: true, details: `REST baseUrl configured: ${c.rest.baseUrl}` };
    return { reachable: false, details: "no REST baseUrl configured" };
  }
  if (c.kind === "context") {
    if (c.context?.build) return { reachable: true, details: "context builder registered" };
    return { reachable: false, details: "no context builder" };
  }
  return { reachable: false, details: `unknown connector kind: ${c.kind}` };
}

export function registerConnectorHandlers(router: Router, app: AppContext): void {
  router.handle("connectors/list", async () => {
    const reg = getConnectorRegistry(app);
    const mcpDir = resolveMcpConfigsDir();
    return { connectors: reg.list().map((c) => view(c, mcpDir)) };
  });

  router.handle("connectors/get", async (params) => {
    const { name } = extract<{ name: string }>(params, ["name"]);
    const c = getConnectorRegistry(app).get(name);
    if (!c) throw new RpcError(`Connector ${name} not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { connector: view(c, resolveMcpConfigsDir()) };
  });

  router.handle("connectors/test", async (params) => {
    const { name } = extract<{ name: string }>(params, ["name"]);
    const c = getConnectorRegistry(app).get(name);
    if (!c) throw new RpcError(`Connector ${name} not found`, ErrorCodes.SESSION_NOT_FOUND);
    const { reachable, details } = probe(c, resolveMcpConfigsDir());
    return { name, reachable, details };
  });
}

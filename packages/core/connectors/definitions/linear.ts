/**
 * Linear connector -- mounts the shipped `mcp-configs/linear.json` MCP
 * server. Tools become available as `mcp__linear__<tool>`.
 */

import type { Connector } from "../types.js";

export const linearConnector: Connector = {
  name: "linear",
  kind: "mcp",
  status: "full",
  label: "Linear (via MCP)",
  auth: { kind: "env", envVar: "LINEAR_API_KEY" },
  mcp: { configName: "linear" },
};

/**
 * GitHub connector -- mounts the shipped `mcp-configs/github.json`
 * MCP server. Tools become available as `mcp__github__<tool>`.
 */

import type { Connector } from "../types.js";

export const githubConnector: Connector = {
  name: "github",
  kind: "mcp",
  status: "full",
  label: "GitHub (via MCP)",
  auth: { kind: "env", envVar: "GITHUB_TOKEN" },
  mcp: { configName: "github" },
};

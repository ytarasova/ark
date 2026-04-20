/**
 * Jira connector -- reuses the shipped `mcp-configs/atlassian.json` MCP
 * server. Tools become available as `mcp__atlassian__<tool>` (the upstream
 * Atlassian MCP server name).
 *
 * Auth: handled by the atlassian MCP server itself via `${ATLASSIAN_*}`
 * env placeholders inside the config.
 */

import type { Connector } from "../types.js";

export const jiraConnector: Connector = {
  name: "jira",
  kind: "mcp",
  status: "full",
  label: "Jira (via Atlassian MCP)",
  auth: { kind: "env", envVar: "ATLASSIAN_API_TOKEN" },
  mcp: { configName: "atlassian" },
};

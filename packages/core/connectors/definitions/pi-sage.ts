/**
 * pi-sage connector -- mounts the shipped `mcp-configs/pi-sage.json` into
 * an agent session. Tools (kb_search, kb_blast_radius, kb_graph,
 * jira_get_issue, ...) become available as `mcp__pi-sage__<tool>`.
 *
 * Auth: pi-sage MCP entries usually carry `${PI_SAGE_TOKEN}` placeholders
 * that `expandEnvPlaceholders()` substitutes at dispatch -- see
 * packages/core/claude/claude.ts.
 */

import type { Connector } from "../types.js";

export const piSageConnector: Connector = {
  name: "pi-sage",
  kind: "mcp",
  status: "full",
  label: "Pi-sage (Paytm KB + Jira intelligence)",
  auth: { kind: "env", envVar: "PI_SAGE_TOKEN" },
  mcp: { configName: "pi-sage" },
};

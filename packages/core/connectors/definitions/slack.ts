/**
 * Slack connector -- scaffolded.
 *
 * No vetted Slack MCP server ships in `mcp-configs/`. We expose an inline
 * stub keyed on `${SLACK_BOT_TOKEN}` so flows can declare it; substitute
 * a real upstream MCP server name + binary path once chosen.
 *
 * TODO: pick a Slack MCP server (slack/mcp or upstream community impl)
 * and promote to `full`.
 */

import type { Connector } from "../types.js";

export const slackConnector: Connector = {
  name: "slack",
  kind: "mcp",
  status: "scaffolded",
  label: "Slack (stub)",
  auth: { kind: "env", envVar: "SLACK_BOT_TOKEN" },
  mcp: {
    inline: {
      slack: {
        command: "${SLACK_MCP_BIN:-mcp-slack}",
        args: [],
        env: {
          SLACK_BOT_TOKEN: "${SLACK_BOT_TOKEN}",
          SLACK_TEAM_ID: "${SLACK_TEAM_ID:-}",
        },
      },
    },
  },
};

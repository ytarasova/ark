/**
 * Bitbucket connector -- scaffolded.
 *
 * No `mcp-configs/bitbucket.json` ships today. The connector exposes an
 * inline MCP server stub so flows can declare `connectors: [bitbucket]`
 * without erroring; the inline stub fails fast at runtime if the upstream
 * `mcp-bitbucket` binary is not installed, which is the right behaviour
 * (visible failure rather than silent skip).
 *
 * TODO: ship a vetted bitbucket MCP server config once one exists.
 */

import type { Connector } from "../types.js";

export const bitbucketConnector: Connector = {
  name: "bitbucket",
  kind: "mcp",
  status: "scaffolded",
  label: "Bitbucket (stub)",
  auth: { kind: "env", envVar: "BITBUCKET_ACCESS_TOKEN" },
  mcp: {
    inline: {
      bitbucket: {
        // The expected upstream MCP server name. Override the binary path
        // via BITBUCKET_MCP_BIN. Until an upstream MCP package ships, the
        // server fails to launch -- the agent surface degrades gracefully.
        command: "${BITBUCKET_MCP_BIN:-mcp-bitbucket}",
        args: [],
        env: {
          BITBUCKET_ACCESS_TOKEN: "${BITBUCKET_ACCESS_TOKEN}",
          BITBUCKET_WORKSPACE: "${BITBUCKET_WORKSPACE:-paytmteam}",
        },
      },
    },
  },
};

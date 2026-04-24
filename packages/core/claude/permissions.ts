/**
 * Agent tool + MCP declaration -> Claude Code permissions & prompt hints.
 *
 * Permissions are defense-in-depth (only enforced when
 * --dangerously-skip-permissions is off). The prompt-hint block is the
 * primary surface that tells the agent which tools it has, and runs on
 * every dispatch regardless of autonomy.
 */

export interface AgentToolSpec {
  tools?: string[];
  mcp_servers?: (string | Record<string, unknown>)[];
}

/** Extract the set of MCP server names the agent explicitly declares. */
function declaredMcpServers(agent: AgentToolSpec): Set<string> {
  const out = new Set<string>();
  for (const srv of agent.mcp_servers ?? []) {
    if (srv && typeof srv === "object") {
      for (const key of Object.keys(srv)) out.add(key);
    } else if (typeof srv === "string") {
      const base = srv.split("/").pop() ?? srv;
      out.add(base.replace(/\.json$/, ""));
    }
  }
  return out;
}

/** Extract server names referenced by explicit `mcp__<server>__<tool>` entries in agent.tools. */
function explicitMcpServerRefs(tools: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tools) {
    const parts = t.split("__");
    if (parts[0] === "mcp" && parts.length >= 3) out.add(parts[1]);
  }
  return out;
}

/**
 * Build a Claude Code `permissions.allow` list from an agent's tool + MCP declarations.
 *
 * Rules:
 *  1. Every entry in `agent.tools` is included as-is -- built-in names (Bash, Read, ...),
 *     explicit MCP entries (`mcp__atlassian__getJiraIssue`), or wildcards (`mcp__atlassian__*`).
 *  2. For each declared `mcp_servers` entry that has no explicit `mcp__<server>__` reference
 *     in `agent.tools`, an implicit `mcp__<server>__*` wildcard is appended so existing
 *     agents that only list servers keep working.
 *  3. Any `mcp__<server>__*` entry in `agent.tools` that references a server NOT declared
 *     in `agent.mcp_servers` is a configuration error and throws.
 */
export function buildPermissionsAllow(agent: AgentToolSpec): string[] {
  const tools = agent.tools ?? [];
  const declared = declaredMcpServers(agent);
  const explicit = explicitMcpServerRefs(tools);

  for (const name of explicit) {
    if (!declared.has(name)) {
      throw new Error(
        `Agent tool entry 'mcp__${name}__*' references MCP server '${name}' ` +
          `which is not declared in mcp_servers. Add '${name}' to mcp_servers or remove the tool entry.`,
      );
    }
  }

  const allow = [...tools];
  for (const name of declared) {
    if (!explicit.has(name)) allow.push(`mcp__${name}__*`);
  }
  return allow;
}

/**
 * Build a prompt-hint section telling the agent which tools and MCP servers
 * are available, so it does not waste turns probing or listing tools.
 *
 * This is the *primary* channel for `agent.tools` / `agent.mcp_servers` --
 * the settings.local.json `permissions.allow` list is defense-in-depth and
 * only takes effect when --dangerously-skip-permissions is off. The prompt
 * hint runs in every dispatch regardless of autonomy.
 */
export function buildToolHints(agent: AgentToolSpec): string {
  const tools = agent.tools ?? [];
  const declared = declaredMcpServers(agent);

  if (tools.length === 0 && declared.size === 0) return "";

  const builtinNames = tools.filter((t) => !t.startsWith("mcp__"));
  const explicitMcpTools = tools.filter((t) => t.startsWith("mcp__") && !t.endsWith("__*"));

  const sections: string[] = ["## Available tools", ""];

  if (builtinNames.length > 0) {
    sections.push(`**Built-in:** ${builtinNames.join(", ")}`);
  }

  if (declared.size > 0) {
    const serverLines = [...declared].map((name) => `- \`${name}\` -- call via \`mcp__${name}__<toolName>\``);
    sections.push("", "**MCP servers:**", ...serverLines);
  }

  if (explicitMcpTools.length > 0) {
    sections.push("", `**Specific MCP tools granted:** ${explicitMcpTools.join(", ")}`);
  }

  sections.push(
    "",
    "Call these tools directly when the task requires them. Do not probe, list, or ask which tools exist -- the list above is authoritative.",
  );

  return sections.join("\n");
}

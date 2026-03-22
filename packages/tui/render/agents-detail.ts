import * as core from "../../core/index.js";
import { state } from "../state.js";

export function renderAgentDetail(): string[] | null {
  const a = state.agents[state.sel] ? core.loadAgent(state.agents[state.sel]!.name) : null;
  if (!a) return null;

  const lines: string[] = [];
  lines.push(`{bold} ${a.name}{/bold} {gray-fg}(${a._source}){/gray-fg}`);
  if (a.description) lines.push(`{gray-fg} ${a.description}{/gray-fg}`);
  lines.push("", "{bold}{inverse} Config {/inverse}{/bold}");
  lines.push(` Model:      ${a.model}`);
  lines.push(` Max turns:  ${a.max_turns}`);
  lines.push(` Permission: ${a.permission_mode}`);

  const sections = [
    ["Tools", a.tools],
    ["MCP Servers", a.mcp_servers.map(String)],
    ["Skills", a.skills],
    ["Memories", a.memories],
    ["Context", a.context],
  ] as const;

  for (const [title, items] of sections) {
    lines.push("", `{bold}{inverse} ${title} (${items.length}) {/inverse}{/bold}`);
    if (items.length) {
      for (const item of items) lines.push(` • ${item}`);
    } else {
      lines.push(` {gray-fg}(none){/gray-fg}`);
    }
  }

  if (a.system_prompt) {
    lines.push("", "{bold}{inverse} System Prompt {/inverse}{/bold}");
    for (const line of a.system_prompt.split("\n").slice(0, 6)) {
      lines.push(` {gray-fg}${line}{/gray-fg}`);
    }
  }

  return lines;
}

import { state } from "../state.js";
import { listPane } from "../layout.js";
import { renderSessionsList } from "./sessions-list.js";
import { renderHostsList } from "./hosts-list.js";
import { renderRow } from "./helpers.js";

export function renderList() {
  const lines: string[] = [];

  if (state.tab === "sessions") {
    lines.push(...renderSessionsList());
  } else if (state.tab === "agents") {
    for (let i = 0; i < state.agents.length; i++) {
      const a = state.agents[i]!;
      const isSel = i === state.sel;
      lines.push(renderRow(` ${isSel ? "▸" : " "} ${a.name.padEnd(16)} ${a.model.padEnd(6)} T:${a.tools.length} M:${a.mcp_servers.length} S:${a.skills.length}`, isSel));
    }
  } else if (state.tab === "pipelines") {
    for (let i = 0; i < state.pipelines.length; i++) {
      const p = state.pipelines[i]!;
      const isSel = i === state.sel;
      lines.push(renderRow(` ${isSel ? "▸" : " "} ${p.name.padEnd(14)} ${p.stages.join(" > ").slice(0, 40)}`, isSel));
    }
  } else if (state.tab === "hosts") {
    lines.push(...renderHostsList());
  } else if (state.tab === "recipes") {
    lines.push("{gray-fg}  No recipes yet.{/gray-fg}");
  }

  listPane.setContent(lines.join("\n"));
}

import { state } from "../state.js";
import { listPane } from "../layout.js";
import { renderSessionsList } from "./sessions-list.js";
import { renderHostsList } from "./hosts-list.js";

export function renderList() {
  const lines: string[] = [];

  if (state.tab === "sessions") {
    lines.push(...renderSessionsList());
  } else if (state.tab === "agents") {
    for (let i = 0; i < state.agents.length; i++) {
      const a = state.agents[i]!;
      const isSel = i === state.sel;
      const prefix = isSel ? "{bold}{inverse}" : "";
      const suffix = isSel ? "{/inverse}{/bold}" : "";
      lines.push(`${prefix} ${isSel ? "▸" : " "} ${a.name.padEnd(16)} ${a.model.padEnd(6)} T:${a.tools.length} M:${a.mcp_servers.length} S:${a.skills.length}${suffix}`);
    }
  } else if (state.tab === "pipelines") {
    for (let i = 0; i < state.pipelines.length; i++) {
      const p = state.pipelines[i]!;
      const isSel = i === state.sel;
      const prefix = isSel ? "{bold}{inverse}" : "";
      const suffix = isSel ? "{/inverse}{/bold}" : "";
      lines.push(`${prefix} ${isSel ? "▸" : " "} ${p.name.padEnd(14)} ${p.stages.join(" > ").slice(0, 40)}${suffix}`);
    }
  } else if (state.tab === "hosts") {
    lines.push(...renderHostsList());
  }

  listPane.setContent(lines.join("\n"));
}

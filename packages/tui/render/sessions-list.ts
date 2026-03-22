import { state } from "../state.js";
import { ICON, COLOR } from "../constants.js";
import { ago } from "../helpers.js";
import { renderRow } from "./helpers.js";

export function renderSessionsList(): string[] {
  const lines: string[] = [];
  const { sessions, sel } = state;

  // Group sessions
  const parentIds = new Set(sessions.filter((s) => s.parent_id).map((s) => s.parent_id));
  const childIds = new Set(sessions.filter((s) => s.parent_id).map((s) => s.id));

  // Organize by group
  const groups = new Map<string, typeof sessions>();
  for (const s of sessions) {
    if (childIds.has(s.id)) continue;
    const g = s.group_name ?? "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(s);
  }

  const sortedGroups = [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  let displayIdx = 0;

  for (const groupName of sortedGroups) {
    if (groupName) {
      lines.push(`{gray-bg}{white-fg} ${groupName} {/white-fg}{/gray-bg}`);
    }

    for (const s of groups.get(groupName)!) {
      const isSel = displayIdx === sel;
      const icon = ICON[s.status] ?? "?";
      const color = COLOR[s.status] ?? "white";
      const summary = (s.jira_summary ?? s.jira_key ?? s.repo ?? "—").slice(0, 22).padEnd(22);
      const stage = (s.stage ?? "—").padEnd(10);
      const age = ago(s.created_at).padStart(4);
      const marker = isSel ? "▸" : " ";

      lines.push(renderRow(` ${marker} {${color}-fg}${icon}{/${color}-fg} ${summary} ${stage} ${age}`, isSel));

      // Show fork children
      if (parentIds.has(s.id)) {
        for (const child of sessions.filter((c) => c.parent_id === s.id)) {
          const ci = ICON[child.status] ?? "?";
          const cc = COLOR[child.status] ?? "white";
          const cs = (child.jira_summary ?? "—").slice(0, 20);
          lines.push(`   ├ {${cc}-fg}${ci}{/${cc}-fg} ${cs}`);
        }
      }
      displayIdx++;
    }
  }

  if (lines.length === 0) {
    lines.push("{gray-fg}  No sessions. Press n to create.{/gray-fg}");
  }

  return lines;
}

import { state } from "../state.js";
import { renderRow } from "./helpers.js";

export function renderHostsList(): string[] {
  const lines: string[] = [];
  const { hosts, sel } = state;

  for (let i = 0; i < hosts.length; i++) {
    const h = hosts[i]!;
    const isSel = i === sel;
    const icon = h.status === "running" ? "{green-fg}●{/green-fg}"
      : h.status === "provisioning" ? "{yellow-fg}●{/yellow-fg}"
      : h.status === "destroyed" ? "{red-fg}✕{/red-fg}"
      : "{gray-fg}○{/gray-fg}";
    const ip = (h.config as Record<string, unknown>).ip ?? "";
    lines.push(renderRow(` ${isSel ? "▸" : " "} ${icon} ${h.name.padEnd(16)} ${h.provider.padEnd(8)} ${String(ip)}`, isSel));
  }
  if (lines.length === 0) {
    lines.push("{gray-fg}  No hosts configured.{/gray-fg}");
  }

  return lines;
}

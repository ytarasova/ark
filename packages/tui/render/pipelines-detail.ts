import * as core from "../../core/index.js";
import { state } from "../state.js";
import { sectionHeader } from "./helpers.js";

export function renderPipelineDetail(): string[] | null {
  const p = state.pipelines[state.sel] ? core.loadPipeline(state.pipelines[state.sel]!.name) : null;
  if (!p) return null;

  const lines: string[] = [];
  lines.push(`{bold} ${p.name}{/bold}`);
  if (p.description) lines.push(`{gray-fg} ${p.description}{/gray-fg}`);
  lines.push("", sectionHeader("Stages"));
  for (let i = 0; i < p.stages.length; i++) {
    const s = p.stages[i]!;
    const type = s.type ?? (s.action ? "action" : "agent");
    const detail = s.agent ?? s.action ?? "";
    const opt = s.optional ? " {gray-fg}(optional){/gray-fg}" : "";
    lines.push(` ${i + 1}. ${s.name.padEnd(14)} {cyan-fg}[${type}:${detail}]{/cyan-fg} gate=${s.gate}${opt}`);
  }

  return lines;
}

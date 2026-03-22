import * as core from "../../core/index.js";
import { state } from "../state.js";
import { screen } from "../layout.js";
import { ICON, COLOR } from "../constants.js";
import { hms } from "../helpers.js";

export function renderSessionDetail(): string[] | null {
  const lines: string[] = [];
  const { sessions, sel } = state;

  const s = sessions.filter((s) => !s.parent_id)[sel];
  if (!s) return null;

  // Header
  lines.push(`{bold} ${s.jira_key ?? s.id}  ${s.jira_summary ?? ""}{/bold}`);
  lines.push("");

  // Pipeline bar
  const stages = core.getStages(s.pipeline);
  const curStage = s.stage;
  let passed = false;
  const bar: string[] = [];
  for (const stg of stages) {
    const isFork = stg.type === "fork";
    if (stg.name === curStage) {
      passed = true;
      const c = COLOR[s.status] ?? "white";
      bar.push(`{${c}-fg}{bold}${isFork ? "⑂" : ICON[s.status] ?? "●"} ${stg.name}{/bold}{/${c}-fg}`);
    } else if (!passed) {
      bar.push(`{green-fg}✓ ${stg.name}{/green-fg}`);
    } else {
      bar.push(`{gray-fg}${isFork ? "⑂" : "○"} ${stg.name}{/gray-fg}`);
    }
  }
  lines.push(" " + bar.join("  >  "));

  // Banners
  if (s.error) lines.push("", `{red-fg}{bold} ✕ ${s.error}{/bold}{/red-fg}`);
  if (s.breakpoint_reason) lines.push("", `{yellow-fg}{bold} ⏸ ${s.breakpoint_reason}{/bold}{/yellow-fg}`);

  // Info
  lines.push("", "{bold}{inverse} Info {/inverse}{/bold}");
  lines.push(` {gray-fg}${"ID".padEnd(11)}{/gray-fg} ${s.id}`);
  const sc = COLOR[s.status] ?? "white";
  lines.push(` {gray-fg}${"Status".padEnd(11)}{/gray-fg} {${sc}-fg}${ICON[s.status] ?? "?"} ${s.status}{/${sc}-fg}`);
  if (s.repo) lines.push(` {gray-fg}${"Repo".padEnd(11)}{/gray-fg} ${s.repo}`);
  if (s.branch) lines.push(` {gray-fg}${"Branch".padEnd(11)}{/gray-fg} ${s.branch}`);
  lines.push(` {gray-fg}${"Pipeline".padEnd(11)}{/gray-fg} ${s.pipeline}`);
  if (s.agent) lines.push(` {gray-fg}${"Agent".padEnd(11)}{/gray-fg} ${s.agent}`);
  if (s.group_name) lines.push(` {gray-fg}${"Group".padEnd(11)}{/gray-fg} ${s.group_name}`);

  // Channel status
  if (s.session_id && s.status === "running") {
    const channelPort = 19200 + parseInt(s.id.replace("s-", ""), 16) % 1000;
    lines.push(` {green-fg}⚡ Channel: port ${channelPort}{/green-fg}`);
  }

  // Latest agent report from events
  const events = core.getEvents(s.id, { limit: 50 });
  const agentReports = events.filter(e => e.type.startsWith("agent_"));
  const latestReport = agentReports[agentReports.length - 1];
  if (latestReport) {
    const d = latestReport.data ?? {};
    const reportType = latestReport.type.replace("agent_", "");
    const reportColor = reportType === "completed" ? "green" : reportType === "error" ? "red" : reportType === "question" ? "yellow" : "cyan";
    lines.push("", `{bold}{inverse} Latest Report {/inverse}{/bold}`);
    const rw = Math.floor((screen.width as number) * 0.6) - 10;
    lines.push(` {${reportColor}-fg}${reportType}{/${reportColor}-fg}: ${String(d.message ?? d.summary ?? d.question ?? d.error ?? "").slice(0, rw)}`);
  }

  // Agent output
  if (s.session_id && s.status === "running") {
    const output = core.getOutput(s.id, { lines: 15 });
    if (output.trim()) {
      const paneWidth = Math.floor((screen.width as number) * 0.6) - 4;
      lines.push("", "{bold}{inverse} Agent Output {/inverse}{/bold}");
      for (const line of output.split("\n").slice(-12)) {
        lines.push(` ${line.slice(0, paneWidth)}`);
      }
    }
  } else if (!s.session_id && (s.status === "ready" || s.status === "blocked")) {
    lines.push("", "{gray-fg} Press {bold}Enter{/bold} to dispatch agent{/gray-fg}");
  }

  // Events
  if (events.length) {
    lines.push("", "{bold}{inverse} Events {/inverse}{/bold}");
    for (const ev of events.slice(-10)) {
      const ts = hms(ev.created_at);
      const data = ev.data
        ? Object.entries(ev.data).slice(0, 2).map(([k, v]) => `${k}=${String(v).slice(0, 20)}`).join(" ")
        : "";
      const evLine = ` {gray-fg}${ts}{/gray-fg}  ${ev.type.padEnd(20)} {cyan-fg}${(ev.stage ?? "").padEnd(10)}{/cyan-fg} {gray-fg}${data}{/gray-fg}`;
      lines.push(evLine);
    }
  }

  return lines;
}

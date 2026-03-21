#!/usr/bin/env bun
/**
 * Ark TUI — blessed-based dashboard with proper split panes.
 *
 * Layout:
 * ┌─ Tab Bar ──────────────────────────────────────────────────┐
 * │ 1:Sessions  2:Agents  3:Pipelines  4:Recipes               │
 * ├─ List ──────────────┬─ Detail ─────────────────────────────┤
 * │ ▸ ◎ Auth middleware │ T-1  Auth middleware                  │
 * │   ◎ Fix bug         │                                       │
 * │   ◎ Update deps     │ ◎ plan > ○ implement > ○ pr          │
 * │                     │                                       │
 * │                     │ Info                                   │
 * │                     │  ID: s-abc123                          │
 * │                     │  Status: ready                         │
 * │                     │                                       │
 * │                     │ Events                                 │
 * │                     │  14:08 session_created ...             │
 * ├─ Status Bar ────────┴───────────────────────────────────────┤
 * │ 3 sessions  j/k:move Enter:dispatch q:quit                  │
 * └─────────────────────────────────────────────────────────────┘
 */

import blessed from "neo-blessed";
import * as core from "../core/index.js";

// ── Icons ───────────────────────────────────────────────────────────────────

const ICON: Record<string, string> = {
  running: "●", waiting: "⏸", pending: "○", ready: "◎",
  completed: "✓", failed: "✕", blocked: "■",
};

const COLOR: Record<string, string> = {
  running: "blue", waiting: "yellow", completed: "green",
  failed: "red", blocked: "yellow", ready: "cyan",
};

// ── State ───────────────────────────────────────────────────────────────────

type Tab = "sessions" | "agents" | "pipelines" | "recipes";

let tab: Tab = "sessions";
let sel = 0;
let sessions: core.Session[] = [];
let agents: ReturnType<typeof core.listAgents> = [];
let pipelines: ReturnType<typeof core.listPipelines> = [];
let eventViewMode = false;
let eventSel = 0;

function refresh() {
  try {
    sessions = core.listSessions({ limit: 50 });
    agents = core.listAgents();
    pipelines = core.listPipelines();
  } catch (e) {
    // SQLite may be briefly locked by another process — skip this refresh
  }
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return "now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function hms(iso: string | null): string {
  if (!iso) return "";
  try { return new Date(iso).toISOString().slice(11, 19); } catch { return ""; }
}

// ── Screen ──────────────────────────────────────────────────────────────────

const screen = blessed.screen({
  smartCSR: true,
  title: "Ark — Autonomous Agent Ecosystem",
  fullUnicode: true,
  terminal: "xterm-256color",
  warnings: false,
  forceUnicode: true,
});

// ── Tab Bar ─────────────────────────────────────────────────────────────────

const tabBar = blessed.box({
  parent: screen,
  top: 0,
  left: 0,
  width: "100%",
  height: 1,
  tags: true,
  style: { bg: "black", fg: "white" },
});

function renderTabBar() {
  const tabs: { key: string; label: string; t: Tab }[] = [
    { key: "1", label: "Sessions", t: "sessions" },
    { key: "2", label: "Agents", t: "agents" },
    { key: "3", label: "Pipelines", t: "pipelines" },
    { key: "4", label: "Recipes", t: "recipes" },
  ];
  const parts = tabs.map((t) =>
    t.t === tab
      ? `{black-bg}{white-fg}{bold} ${t.key}:${t.label} {/bold}{/white-fg}{/black-bg}`
      : `{gray-fg} ${t.key}:${t.label} {/gray-fg}`
  );
  tabBar.setContent(parts.join(" "));
}

// ── List Pane ───────────────────────────────────────────────────────────────

const listPane = blessed.box({
  parent: screen,
  top: 1,
  left: 0,
  width: "40%",
  height: "100%-3",
  border: { type: "line" },
  style: { border: { fg: "gray" } },
  scrollable: true,
  alwaysScroll: true,
  scrollbar: { style: { bg: "gray" } },
  tags: true,
});

function renderList() {
  const lines: string[] = [];

  if (tab === "sessions") {
    // Group sessions
    const parentIds = new Set(sessions.filter((s) => s.parent_id).map((s) => s.parent_id));
    const childIds = new Set(sessions.filter((s) => s.parent_id).map((s) => s.id));

    // Organize by group
    const groups = new Map<string, core.Session[]>();
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
        const prefix = isSel ? "{bold}{inverse}" : "";
        const suffix = isSel ? "{/inverse}{/bold}" : "";

        lines.push(`${prefix} ${marker} {${color}-fg}${icon}{/${color}-fg} ${summary} ${stage} ${age}${suffix}`);

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
  } else if (tab === "agents") {
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]!;
      const isSel = i === sel;
      const prefix = isSel ? "{bold}{inverse}" : "";
      const suffix = isSel ? "{/inverse}{/bold}" : "";
      lines.push(`${prefix} ${isSel ? "▸" : " "} ${a.name.padEnd(16)} ${a.model.padEnd(6)} T:${a.tools.length} M:${a.mcp_servers.length} S:${a.skills.length}${suffix}`);
    }
  } else if (tab === "pipelines") {
    for (let i = 0; i < pipelines.length; i++) {
      const p = pipelines[i]!;
      const isSel = i === sel;
      const prefix = isSel ? "{bold}{inverse}" : "";
      const suffix = isSel ? "{/inverse}{/bold}" : "";
      lines.push(`${prefix} ${isSel ? "▸" : " "} ${p.name.padEnd(14)} ${p.stages.join(" > ").slice(0, 40)}${suffix}`);
    }
  }

  listPane.setContent(lines.join("\n"));
}

// ── Detail Pane ─────────────────────────────────────────────────────────────

const detailPane = blessed.box({
  parent: screen,
  top: 1,
  left: "40%",
  width: "60%",
  height: "100%-3",
  border: { type: "line" },
  style: { border: { fg: "gray" } },
  scrollable: true,
  alwaysScroll: true,
  scrollbar: { style: { bg: "gray" } },
  tags: true,
});

function renderDetail() {
  try { return _renderDetail(); } catch { /* SQLite locked */ }
}

function _renderDetail() {
  const lines: string[] = [];

  if (tab === "sessions") {
    const s = sessions.filter((s) => !s.parent_id)[sel];
    if (!s) {
      detailPane.setContent("{gray-fg}← select a session{/gray-fg}");
      return;
    }

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

  } else if (tab === "agents") {
    const a = agents[sel] ? core.loadAgent(agents[sel]!.name) : null;
    if (!a) { detailPane.setContent(""); return; }

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

  } else if (tab === "pipelines") {
    const p = pipelines[sel] ? core.loadPipeline(pipelines[sel]!.name) : null;
    if (!p) { detailPane.setContent(""); return; }

    lines.push(`{bold} ${p.name}{/bold}`);
    if (p.description) lines.push(`{gray-fg} ${p.description}{/gray-fg}`);
    lines.push("", "{bold}{inverse} Stages {/inverse}{/bold}");
    for (let i = 0; i < p.stages.length; i++) {
      const s = p.stages[i]!;
      const type = s.type ?? (s.action ? "action" : "agent");
      const detail = s.agent ?? s.action ?? "";
      const opt = s.optional ? " {gray-fg}(optional){/gray-fg}" : "";
      lines.push(` ${i + 1}. ${s.name.padEnd(14)} {cyan-fg}[${type}:${detail}]{/cyan-fg} gate=${s.gate}${opt}`);
    }
  }

  detailPane.setContent(lines.join("\n"));
}

// ── Status Bar ──────────────────────────────────────────────────────────────

const statusBar = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  width: "100%",
  height: 2,
  tags: true,
  style: { bg: "black", fg: "gray" },
});

function renderStatusBar() {
  const nRun = sessions.filter((s) => s.status === "running").length;
  const nWait = sessions.filter((s) => s.status === "waiting").length;
  const nErr = sessions.filter((s) => s.status === "failed").length;

  let left = ` ${sessions.length} sessions`;
  if (nRun) left += `  {blue-fg}● ${nRun} running{/blue-fg}`;
  if (nWait) left += `  {yellow-fg}⏸ ${nWait} waiting{/yellow-fg}`;
  if (nErr) left += `  {red-fg}✕ ${nErr} errors{/red-fg}`;

  const keys = tab === "sessions"
    ? "j/k:move  Enter:dispatch  a:attach  c:done  s:stop  r:resume  n:new  x:kill  q:quit"
    : tab === "agents"
    ? "j/k:move  e:edit  q:quit"
    : "j/k:move  q:quit";

  statusBar.setContent(`${left}   {gray-fg}${keys}{/gray-fg}`);
}

// ── Render all ──────────────────────────────────────────────────────────────

function renderAll() {
  refresh();
  renderTabBar();
  renderList();
  renderDetail();
  renderStatusBar();
  screen.render();
}

// ── Key bindings ────────────────────────────────────────────────────────────

screen.key(["q", "C-c"], () => process.exit(0));

screen.key(["j", "down"], () => {
  const max = tab === "sessions" ? sessions.filter((s) => !s.parent_id).length
    : tab === "agents" ? agents.length
    : tab === "pipelines" ? pipelines.length : 0;
  if (sel < max - 1) sel++;
  renderAll();
});

screen.key(["k", "up"], () => {
  if (sel > 0) sel--;
  renderAll();
});

screen.key(["1"], () => { tab = "sessions"; sel = 0; renderAll(); });
screen.key(["2"], () => { tab = "agents"; sel = 0; renderAll(); });
screen.key(["3"], () => { tab = "pipelines"; sel = 0; renderAll(); });
screen.key(["4"], () => { tab = "recipes"; sel = 0; renderAll(); });

screen.key(["]", "tab"], () => {
  const tabs: Tab[] = ["sessions", "agents", "pipelines", "recipes"];
  tab = tabs[(tabs.indexOf(tab) + 1) % tabs.length]!;
  sel = 0;
  renderAll();
});

screen.key(["[", "S-tab"], () => {
  const tabs: Tab[] = ["sessions", "agents", "pipelines", "recipes"];
  tab = tabs[(tabs.indexOf(tab) - 1 + tabs.length) % tabs.length]!;
  sel = 0;
  renderAll();
});

screen.key(["enter"], () => {
  if (tab === "sessions") {
    const topLevel = sessions.filter((s) => !s.parent_id);
    const s = topLevel[sel];
    if (s && (s.status === "ready" || s.status === "blocked")) {
      core.dispatch(s.id);
      renderAll();
    }
  }
});

screen.key(["c"], () => {
  if (tab === "sessions") {
    const topLevel = sessions.filter((s) => !s.parent_id);
    const s = topLevel[sel];
    if (s && s.status === "running") {
      core.complete(s.id);
      renderAll();
    }
  }
});

screen.key(["s"], () => {
  if (tab === "sessions") {
    const topLevel = sessions.filter((s) => !s.parent_id);
    const s = topLevel[sel];
    if (s && !["completed", "failed"].includes(s.status)) {
      core.stop(s.id);
      renderAll();
    }
  }
});

screen.key(["r"], () => {
  if (tab === "sessions") {
    const topLevel = sessions.filter((s) => !s.parent_id);
    const s = topLevel[sel];
    if (s && ["blocked", "waiting", "failed"].includes(s.status)) {
      core.resume(s.id);
      renderAll();
    }
  }
});

screen.key(["x"], () => {
  if (tab === "sessions") {
    const topLevel = sessions.filter((s) => !s.parent_id);
    const s = topLevel[sel];
    if (s) {
      if (s.session_id) core.killSession(s.session_id);
      core.deleteSession(s.id);
      if (sel > 0) sel--;
      renderAll();
    }
  }
});

screen.key(["n"], () => {
  if (tab !== "sessions") return;

  // Sequential prompts using blessed.prompt (reliable value capture)
  const prompt = blessed.prompt({
    parent: screen,
    top: "center",
    left: "center",
    width: 70,
    height: 8,
    border: { type: "line" },
    style: { border: { fg: "cyan" }, bg: "black" },
    tags: true,
  });

  const ask = (question: string, defaultVal: string): Promise<string | null> =>
    new Promise((resolve) => {
      prompt.input(`{bold}New Session{/bold}\n\n${question}`, defaultVal, (err, value) => {
        if (err || value === undefined || value === null) resolve(null);
        else resolve(value.trim());
      });
    });

  (async () => {
    const summary = await ask("Task / summary:", "");
    if (summary === null) return; // Esc pressed

    const repoPath = await ask("Repo path:", process.cwd());
    if (repoPath === null) return;

    const pipelineName = await ask("Pipeline:", "default");
    if (pipelineName === null) return;

    // Create session
    const { existsSync } = require("fs");
    const { resolve: resolvePath, basename } = require("path");
    let workdir: string | undefined;
    let repo = repoPath || process.cwd();
    const rp = resolvePath(repo);
    if (existsSync(rp)) {
      workdir = rp;
      if (repo === "." || repo === "./") repo = basename(rp);
    }

    const s = core.startSession({
      jira_summary: summary || "Ad-hoc task",
      repo, pipeline: pipelineName || "default", workdir,
    });
    core.dispatch(s.id);

    prompt.destroy();
    renderAll();
  })();
});

screen.key(["a"], () => {
  if (tab !== "sessions") return;
  const topLevel = sessions.filter((s) => !s.parent_id);
  const s = topLevel[sel];
  if (!s?.session_id) return;

  // Destroy blessed screen, attach to tmux, re-exec TUI after detach
  screen.destroy();
  const cp = require("child_process");
  try {
    cp.execFileSync("tmux", ["attach", "-t", s.session_id], { stdio: "inherit" });
  } catch { /* user detached with Ctrl+B D */ }

  // Re-launch TUI after detach
  cp.execFileSync(process.execPath, [__filename], { stdio: "inherit" });
  process.exit(0);
});

screen.key(["G"], () => {
  const max = tab === "sessions" ? sessions.filter((s) => !s.parent_id).length
    : tab === "agents" ? agents.length
    : tab === "pipelines" ? pipelines.length : 0;
  sel = Math.max(0, max - 1);
  renderAll();
});

screen.key(["g"], () => {
  sel = 0;
  renderAll();
});

// ── Auto-refresh ────────────────────────────────────────────────────────────

setInterval(renderAll, 3000);

// ── Start ───────────────────────────────────────────────────────────────────

renderAll();

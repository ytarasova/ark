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
import { getProvider, listProviders } from "../compute/index.js";
import type { HostSnapshot } from "../compute/types.js";

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

type Tab = "sessions" | "agents" | "pipelines" | "recipes" | "hosts";

let tab: Tab = "sessions";
let sel = 0;
let sessions: core.Session[] = [];
let agents: ReturnType<typeof core.listAgents> = [];
let pipelines: ReturnType<typeof core.listPipelines> = [];
let hosts: core.Host[] = [];
let hostSnapshots = new Map<string, HostSnapshot>();
let eventViewMode = false;
let eventSel = 0;

function refresh() {
  try {
    sessions = core.listSessions({ limit: 50 });
    agents = core.listAgents();
    pipelines = core.listPipelines();
    hosts = core.listHosts();
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
    { key: "5", label: "Hosts", t: "hosts" },
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
  } else if (tab === "hosts") {
    for (let i = 0; i < hosts.length; i++) {
      const h = hosts[i]!;
      const isSel = i === sel;
      const prefix = isSel ? "{bold}{inverse}" : "";
      const suffix = isSel ? "{/inverse}{/bold}" : "";
      const icon = h.status === "running" ? "{green-fg}●{/green-fg}"
        : h.status === "provisioning" ? "{yellow-fg}●{/yellow-fg}"
        : h.status === "destroyed" ? "{red-fg}✕{/red-fg}"
        : "{gray-fg}○{/gray-fg}";
      const ip = (h.config as Record<string, unknown>).ip ?? "";
      lines.push(`${prefix} ${isSel ? "▸" : " "} ${icon} ${h.name.padEnd(16)} ${h.provider.padEnd(8)} ${String(ip)}${suffix}`);
    }
    if (lines.length === 0) {
      lines.push("{gray-fg}  No hosts configured.{/gray-fg}");
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

  } else if (tab === "hosts") {
    const h = hosts[sel];
    if (!h) { detailPane.setContent("{gray-fg}← select a host{/gray-fg}"); return; }

    const cfg = h.config as Record<string, unknown>;
    lines.push(`{bold} ${h.name}{/bold}  {gray-fg}${h.provider}{/gray-fg}`);
    if (cfg.instanceType) lines.push(` {gray-fg}Instance{/gray-fg}  ${cfg.instanceType}`);
    const sc = h.status === "running" ? "green"
      : h.status === "provisioning" ? "yellow"
      : h.status === "destroyed" ? "red" : "gray";
    lines.push(` {gray-fg}Status{/gray-fg}    {${sc}-fg}${h.status}{/${sc}-fg}`);
    if (cfg.ip) lines.push(` {gray-fg}IP{/gray-fg}        ${cfg.ip}`);

    const snap = hostSnapshots.get(h.name);
    if (snap) {
      const m = snap.metrics;
      lines.push("", "{bold}{inverse} Metrics {/inverse}{/bold}");
      lines.push(` CPU   ${bar(m.cpu, 30)}  ${m.cpu.toFixed(1)}%`);
      lines.push(` MEM   ${bar(m.memPct, 30)}  ${m.memUsedGb.toFixed(1)}/${m.memTotalGb.toFixed(1)} GB`);
      lines.push(` DISK  ${bar(m.diskPct, 30)}  ${m.diskPct.toFixed(1)}%`);
      lines.push("");
      lines.push(` {gray-fg}Net RX{/gray-fg}  ${m.netRxMb.toFixed(1)} MB   {gray-fg}TX{/gray-fg}  ${m.netTxMb.toFixed(1)} MB`);
      lines.push(` {gray-fg}Uptime{/gray-fg}  ${m.uptime}   {gray-fg}Idle{/gray-fg}  ${m.idleTicks} ticks`);

      if (snap.sessions.length) {
        lines.push("", "{bold}{inverse} Sessions {/inverse}{/bold}");
        lines.push(` ${"Name".padEnd(18)} ${"Status".padEnd(10)} ${"Mode".padEnd(8)} ${"CPU".padEnd(6)} ${"MEM".padEnd(6)}`);
        for (const s of snap.sessions) {
          lines.push(` ${s.name.padEnd(18)} ${s.status.padEnd(10)} ${s.mode.padEnd(8)} ${String(s.cpu).padEnd(6)} ${String(s.mem).padEnd(6)}`);
        }
      }

      if (snap.processes.length) {
        lines.push("", "{bold}{inverse} Processes {/inverse}{/bold}");
        lines.push(` ${"PID".padEnd(8)} ${"CPU".padEnd(6)} ${"MEM".padEnd(6)} ${"Command"}`);
        for (const p of snap.processes.slice(0, 10)) {
          lines.push(` ${p.pid.padEnd(8)} ${p.cpu.padEnd(6)} ${p.mem.padEnd(6)} ${p.command.slice(0, 40)}`);
        }
      }

      if (snap.docker.length) {
        lines.push("", "{bold}{inverse} Docker {/inverse}{/bold}");
        lines.push(` ${"Name".padEnd(18)} ${"CPU".padEnd(8)} ${"MEM".padEnd(10)} ${"Image"}`);
        for (const c of snap.docker) {
          lines.push(` ${c.name.padEnd(18)} ${c.cpu.padEnd(8)} ${c.memory.padEnd(10)} ${c.image.slice(0, 30)}`);
        }
      }
    } else if (h.status === "running") {
      lines.push("", "{gray-fg} Fetching metrics...{/gray-fg}");
    }

    // Port status (from running sessions on this host)
    const hostSessions = sessions.filter(s => s.compute_name === h.name && s.status === "running");
    const allPorts: any[] = [];
    for (const s of hostSessions) {
      const ports = (s.config as any)?.ports ?? [];
      allPorts.push(...ports);
    }
    if (allPorts.length > 0) {
      lines.push("", "{bold}{inverse} Ports {/inverse}{/bold}");
      for (const p of allPorts) {
        const statusIcon = p.listening ? "{green-fg}●{/green-fg}" : "{red-fg}○{/red-fg}";
        const name = p.name ? ` (${p.name})` : "";
        lines.push(` ${statusIcon} :${p.port}${name}  ${p.source}  ${p.listening ? "listening" : "closed"}`);
      }
    }

    // Cost estimate
    const rate = (h.config as any)?.hourlyRate;
    if (rate) {
      lines.push("", `{bold}{inverse} Cost {/inverse}{/bold}`);
      lines.push(` $${rate.toFixed(3)}/hr  ~$${(rate * 24).toFixed(2)}/day`);
    }
  }

  detailPane.setContent(lines.join("\n"));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function bar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  const color = pct > 80 ? "red" : pct > 50 ? "yellow" : "green";
  return `{${color}-fg}${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}{/${color}-fg}`;
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

  const keys = tab === "hosts"
    ? "j/k:move  n:new  Enter:provision  s:start/stop  S:sync  x:delete  a:ssh  q:quit"
    : tab === "sessions"
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
    : tab === "pipelines" ? pipelines.length
    : tab === "hosts" ? hosts.length : 0;
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
screen.key(["5"], () => { tab = "hosts"; sel = 0; renderAll(); });

screen.key(["]", "tab"], () => {
  const tabs: Tab[] = ["sessions", "agents", "pipelines", "recipes", "hosts"];
  tab = tabs[(tabs.indexOf(tab) + 1) % tabs.length]!;
  sel = 0;
  renderAll();
});

screen.key(["[", "S-tab"], () => {
  const tabs: Tab[] = ["sessions", "agents", "pipelines", "recipes", "hosts"];
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
  } else if (tab === "hosts") {
    const h = hosts[sel];
    if (!h) return;
    const provider = getProvider(h.provider);
    if (!provider) return;
    if (h.status === "stopped" || h.status === "destroyed") {
      // Provision or start
      (async () => {
        try {
          core.updateHost(h.name, { status: "provisioning" });
          renderAll();
          await provider.provision(h);
          core.updateHost(h.name, { status: "running" });
        } catch { core.updateHost(h.name, { status: "stopped" }); }
        renderAll();
      })();
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
  } else if (tab === "hosts") {
    const h = hosts[sel];
    if (!h) return;
    const provider = getProvider(h.provider);
    if (!provider) return;
    (async () => {
      try {
        if (h.status === "running") {
          await provider.stop(h);
          core.updateHost(h.name, { status: "stopped" });
        } else if (h.status === "stopped") {
          await provider.start(h);
          core.updateHost(h.name, { status: "running" });
        }
      } catch { /* ignore */ }
      renderAll();
    })();
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
  } else if (tab === "hosts") {
    const h = hosts[sel];
    if (!h) return;
    if (h.status === "running") return; // can't delete running host
    core.deleteHost(h.name);
    if (sel > 0) sel--;
    renderAll();
  }
});

screen.key(["n"], () => {
  // ── selectOne: dropdown list selector ──────────────────────────────
  const selectOne = (title: string, items: string[], defaultIdx = 0): Promise<string | null> =>
    new Promise((resolve) => {
      const list = blessed.list({
        parent: screen,
        top: "center", left: "center", width: 50, height: Math.min(items.length + 4, 20),
        border: { type: "line" },
        style: {
          border: { fg: "cyan" }, bg: "black",
          selected: { bg: "cyan", fg: "black" },
          item: { fg: "white" },
        },
        label: ` ${title} `,
        keys: true, vi: true, mouse: true,
        scrollable: true,
        items,
      });
      list.select(defaultIdx);
      list.focus();
      list.on("select", (item: any) => {
        const val = item.getText ? item.getText() : String(item.content ?? items[list.selected ?? 0]);
        list.destroy();
        screen.render();
        resolve(val);
      });
      list.key(["escape"], () => { list.destroy(); screen.render(); resolve(null); });
      screen.render();
    });

  // ── selectOrType: dropdown with "Other..." manual input option ────
  const selectOrType = async (title: string, items: string[], defaultIdx = 0, promptBox?: any): Promise<string | null> => {
    const allItems = [...items, "── Other (type manually) ──"];
    const choice = await selectOne(title, allItems, defaultIdx);
    if (choice === null) return null;
    if (choice.includes("Other (type manually)")) {
      if (!promptBox) return null;
      return new Promise((resolve) => {
        promptBox.input(`{bold}${title}{/bold}\n\nEnter value:`, "", (err: any, value: any) => {
          if (err || value === undefined || value === null) resolve(null);
          else resolve(String(value).trim());
        });
      });
    }
    return choice;
  };

  // ── Fun name generator (adjective-noun) ────────────────────────────
  const generateName = (): string => {
    const adj = ["swift","bold","calm","dark","epic","fast","grim","hazy","keen","loud",
      "mild","neat","odd","pure","rare","slim","tall","vast","warm","wild",
      "blue","gold","iron","jade","ruby","sage","teal","onyx","zinc","moss"];
    const noun = ["wolf","bear","hawk","lynx","puma","crow","deer","dove","frog","hare",
      "kite","lark","mole","newt","orca","pike","quil","rook","swan","toad",
      "vole","wren","yak","ant","bass","crab","dusk","echo","flux","gale"];
    const a = adj[Math.floor(Math.random() * adj.length)];
    const n = noun[Math.floor(Math.random() * noun.length)];
    return `${a}-${n}`;
  };

  // ── AWS profiles from ~/.aws/config ───────────────────────────────
  const getAwsProfiles = (): string[] => {
    try {
      const { readFileSync } = require("fs");
      const { join } = require("path");
      const { homedir } = require("os");
      const cfg = readFileSync(join(homedir(), ".aws", "config"), "utf-8");
      const profiles: string[] = [];
      for (const line of cfg.split("\n")) {
        const m = line.match(/^\[profile\s+(.+)\]$/);
        if (m) profiles.push(m[1]);
        else if (line.match(/^\[default\]$/)) profiles.push("default");
      }
      return profiles;
    } catch { return ["default"]; }
  };

  if (tab === "hosts") {
    // Create new host
    const prompt = blessed.prompt({
      parent: screen,
      top: "center", left: "center", width: 70, height: 8,
      border: { type: "line" },
      style: { border: { fg: "cyan" }, bg: "black" },
      tags: true,
    });

    const ask = (question: string, defaultVal: string): Promise<string | null> =>
      new Promise((resolve) => {
        prompt.input(`{bold}New Host{/bold}\n\n${question}`, defaultVal, (err, value) => {
          if (err || value === undefined || value === null) resolve(null);
          else resolve(value.trim());
        });
      });

    (async () => {
      const name = await ask("Host name:", generateName());
      if (!name) { prompt.destroy(); renderAll(); return; }

      const provider = await selectOne("Provider", ["ec2", "local", "docker"], 0);
      if (!provider) { prompt.destroy(); renderAll(); return; }

      if (provider === "ec2") {
        const sizeOptions = [
          "xs  — Extra Small (2 vCPU, 8 GB)",
          "s   — Small (4 vCPU, 16 GB)",
          "m   — Medium (8 vCPU, 32 GB)",
          "l   — Large (16 vCPU, 64 GB)",
          "xl  — X-Large (32 vCPU, 128 GB)",
          "xxl — 2X-Large (48 vCPU, 192 GB)",
          "xxxl— 4X-Large (64 vCPU, 256 GB)",
        ];
        const sizeChoice = await selectOne("Instance Size", sizeOptions, 2);
        if (!sizeChoice) { prompt.destroy(); renderAll(); return; }
        const size = sizeChoice.split("—")[0].trim().replace(/\s+/g, "");

        const arch = await selectOne("Architecture", ["x64 (Intel)", "arm (Graviton)"], 0);
        if (!arch) { prompt.destroy(); renderAll(); return; }
        const archVal = arch.startsWith("arm") ? "arm" : "x64";

        const regions = [
          "us-east-1      — N. Virginia",
          "us-east-2      — Ohio",
          "us-west-1      — N. California",
          "us-west-2      — Oregon",
          "eu-west-1      — Ireland",
          "eu-west-2      — London",
          "eu-central-1   — Frankfurt",
          "ap-south-1     — Mumbai",
          "ap-southeast-1 — Singapore",
          "ap-northeast-1 — Tokyo",
        ];
        const regionChoice = await selectOrType("AWS Region", regions, 0, prompt);
        if (!regionChoice) { prompt.destroy(); renderAll(); return; }
        const region = regionChoice.split("—")[0].trim().replace(/\s+/g, "");

        const awsProfiles = getAwsProfiles();
        const profileChoice = await selectOrType("AWS Profile", awsProfiles, 0, prompt);
        if (profileChoice === null) { prompt.destroy(); renderAll(); return; }

        try {
          core.createHost({
            name, provider,
            config: {
              size, arch: archVal,
              region: region || "us-east-1",
              ...(profileChoice ? { aws_profile: profileChoice } : {}),
            },
          });
        } catch { /* duplicate name etc */ }
      } else {
        try {
          core.createHost({ name, provider, config: {} });
        } catch { /* duplicate name etc */ }
      }

      prompt.destroy();
      renderAll();
    })();
    return;
  }

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
    if (summary === null) { prompt.destroy(); renderAll(); return; }

    const repoPath = await ask("Repo path:", process.cwd());
    if (repoPath === null) { prompt.destroy(); renderAll(); return; }

    // Host selection
    const hostChoices = ["local (this machine)", ...core.listHosts().map(h => `${h.name} (${h.provider})`)];
    const hostChoice = await selectOne("Compute Host", hostChoices, 0);
    if (!hostChoice) { prompt.destroy(); renderAll(); return; }
    const computeName = hostChoice.startsWith("local") ? undefined : hostChoice.split(" ")[0];

    // Pipeline selection
    const pipelineNames = core.listPipelines().map(p => p.name);
    const pipelineChoice = await selectOne("Pipeline", pipelineNames, 0);
    if (!pipelineChoice) { prompt.destroy(); renderAll(); return; }

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
      repo, pipeline: pipelineChoice, workdir,
      compute_name: computeName,
    });
    core.dispatch(s.id);

    prompt.destroy();
    renderAll();
  })();
});

screen.key(["a"], () => {
  if (tab === "sessions") {
    const topLevel = sessions.filter((s) => !s.parent_id);
    const s = topLevel[sel];
    if (!s?.session_id) return;

    screen.destroy();
    const cp = require("child_process");
    try {
      cp.execFileSync("tmux", ["attach", "-t", s.session_id], { stdio: "inherit" });
    } catch { /* user detached with Ctrl+B D */ }

    cp.execFileSync(process.execPath, [__filename], { stdio: "inherit" });
    process.exit(0);
  } else if (tab === "hosts") {
    const h = hosts[sel];
    if (!h || h.status !== "running") return;
    const ip = (h.config as any)?.ip;
    if (!ip) return;

    screen.destroy();
    const cp = require("child_process");
    const keyPath = require("path").join(require("os").homedir(), ".ssh", `ark-${h.name}`);
    try {
      cp.execFileSync("ssh", ["-i", keyPath, "-o", "StrictHostKeyChecking=no", `ubuntu@${ip}`], { stdio: "inherit" });
    } catch { /* user exited */ }

    cp.execFileSync(process.execPath, [__filename], { stdio: "inherit" });
    process.exit(0);
  }
});

screen.key(["G"], () => {
  const max = tab === "sessions" ? sessions.filter((s) => !s.parent_id).length
    : tab === "agents" ? agents.length
    : tab === "pipelines" ? pipelines.length
    : tab === "hosts" ? hosts.length : 0;
  sel = Math.max(0, max - 1);
  renderAll();
});

screen.key(["g"], () => {
  sel = 0;
  renderAll();
});

// ── Host metrics background fetch ───────────────────────────────────────────

async function refreshHostMetrics() {
  for (const h of hosts) {
    if (h.status !== "running") continue;
    const provider = getProvider(h.provider);
    if (!provider) continue;
    try {
      const snap = await provider.getMetrics(h);
      hostSnapshots.set(h.name, snap);
    } catch { /* skip */ }
  }
}

setInterval(async () => {
  if (tab === "hosts") {
    await refreshHostMetrics();
    renderAll();
  }
}, 10_000);

// ── Auto-refresh ────────────────────────────────────────────────────────────

setInterval(renderAll, 3000);

// ── Start ───────────────────────────────────────────────────────────────────

renderAll();

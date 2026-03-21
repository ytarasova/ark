import React, { useState, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import * as core from "../core/index.js";

// ── Types ───────────────────────────────────────────────────────────────────

type Tab = "sessions" | "agents" | "pipelines" | "recipes";

const TABS: { key: string; label: string; tab: Tab }[] = [
  { key: "1", label: "Sessions", tab: "sessions" },
  { key: "2", label: "Agents", tab: "agents" },
  { key: "3", label: "Pipelines", tab: "pipelines" },
  { key: "4", label: "Recipes", tab: "recipes" },
];

const ICONS: Record<string, string> = {
  running: "●", waiting: "⏸", pending: "○", ready: "◎",
  completed: "✓", failed: "✕", blocked: "■",
};

const STATUS_COLOR: Record<string, string> = {
  running: "blue", waiting: "yellow", completed: "green",
  failed: "red", blocked: "yellow", ready: "cyan",
};

// ── Hooks ───────────────────────────────────────────────────────────────────

function useRefresh(interval: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), interval);
    return () => clearInterval(id);
  }, [interval]);
  return tick;
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// ── Components ──────────────────────────────────────────────────────────────

function TabBar({ active }: { active: Tab }) {
  return (
    <Box>
      {TABS.map((t) => (
        <Box key={t.tab} marginRight={1}>
          {t.tab === active ? (
            <Text bold inverse> {t.key}:{t.label} </Text>
          ) : (
            <Text dimColor> {t.key}:{t.label} </Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

function SessionList({ sessions, selected }: { sessions: core.Session[]; selected: number }) {
  // Group by parent (fork children under parent)
  const parentIds = new Set(sessions.filter((s) => s.parent_id).map((s) => s.parent_id));
  const childIds = new Set(sessions.filter((s) => s.parent_id).map((s) => s.id));

  const rows: { session: core.Session; indent: boolean; idx: number }[] = [];
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!;
    if (childIds.has(s.id)) continue; // shown under parent
    rows.push({ session: s, indent: false, idx: i });
    // Show children
    if (parentIds.has(s.id)) {
      for (let j = 0; j < sessions.length; j++) {
        if (sessions[j]!.parent_id === s.id) {
          rows.push({ session: sessions[j]!, indent: true, idx: j });
        }
      }
    }
  }

  return (
    <Box flexDirection="column">
      {rows.length === 0 && <Text dimColor>  No sessions. Press n to create.</Text>}
      {rows.map(({ session: s, indent, idx }) => {
        const sel = idx === selected;
        const icon = ICONS[s.status] ?? "?";
        const color = STATUS_COLOR[s.status] ?? "white";
        const summary = s.jira_summary ?? s.jira_key ?? s.repo ?? "—";
        const prefix = indent ? "  ├" : sel ? " ▸" : "  ";

        return (
          <Box key={s.id}>
            <Text bold={sel} inverse={sel}>
              {prefix} <Text color={color}>{icon}</Text> {summary.slice(0, 22).padEnd(22)} {(s.stage ?? "—").padEnd(10)} {ago(s.created_at).padStart(4)}
              {s.breakpoint_reason ? <Text color="yellow"> {s.breakpoint_reason.slice(0, 20)}</Text> : null}
              {s.error && s.error !== "Stopped by user" ? <Text color="red"> {s.error.slice(0, 20)}</Text> : null}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function SessionDetail({ session }: { session: core.Session | null }) {
  if (!session) return <Text dimColor>← select a session</Text>;

  const stages = core.getStages(session.pipeline);
  const events = core.getEvents(session.id, { limit: 8 });
  const output = session.session_id && session.status === "running"
    ? core.getOutput(session.id, { lines: 15 })
    : "";

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text bold inverse> {session.jira_key ?? session.id} </Text>
        <Text bold> {session.jira_summary ?? ""}</Text>
      </Box>

      {/* Pipeline bar */}
      <Box marginTop={1}>
        <Text>  </Text>
        {stages.map((stg, i) => {
          const name = stg.name;
          const isCurrent = name === session.stage;
          const isPast = stages.findIndex((s) => s.name === session.stage) > i;
          const isFork = stg.type === "fork";
          return (
            <React.Fragment key={name}>
              {isCurrent ? (
                <Text color={STATUS_COLOR[session.status] ?? "white"} bold>
                  {isFork ? "⑂" : ICONS[session.status] ?? "●"} {name}
                </Text>
              ) : isPast ? (
                <Text color="green">✓ {name}</Text>
              ) : (
                <Text dimColor>{isFork ? "⑂" : "○"} {name}</Text>
              )}
              {i < stages.length - 1 && <Text dimColor> {">"} </Text>}
            </React.Fragment>
          );
        })}
      </Box>

      {/* Error/waiting banner */}
      {session.error && (
        <Box marginTop={1}><Text color="red" bold>  ✕ {session.error}</Text></Box>
      )}
      {session.breakpoint_reason && (
        <Box marginTop={1}><Text color="yellow" bold>  ⏸ {session.breakpoint_reason}</Text></Box>
      )}

      {/* Info */}
      <Box marginTop={1} flexDirection="column">
        <Text bold inverse> Info </Text>
        <Text>  <Text dimColor>{"ID".padEnd(11)}</Text> {session.id}</Text>
        <Text>  <Text dimColor>{"Status".padEnd(11)}</Text> <Text color={STATUS_COLOR[session.status]}>{ICONS[session.status]} {session.status}</Text></Text>
        <Text>  <Text dimColor>{"Repo".padEnd(11)}</Text> {session.repo ?? "—"}</Text>
        <Text>  <Text dimColor>{"Pipeline".padEnd(11)}</Text> {session.pipeline}</Text>
        {session.agent && <Text>  <Text dimColor>{"Agent".padEnd(11)}</Text> {session.agent}</Text>}
      </Box>

      {/* Agent output */}
      {output ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold inverse> Agent Output </Text>
          {output.split("\n").slice(-12).map((line, i) => (
            <Text key={i}>  {line.slice(0, 100)}</Text>
          ))}
        </Box>
      ) : session.status === "ready" ? (
        <Box marginTop={1}>
          <Text dimColor>  Press <Text bold>Enter</Text> to dispatch agent</Text>
        </Box>
      ) : null}

      {/* Events */}
      {events.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold inverse> Events </Text>
          {events.slice(-6).map((ev) => {
            const ts = ev.created_at.slice(11, 19);
            const data = ev.data ? Object.entries(ev.data).slice(0, 3).map(([k, v]) =>
              `${k}=${String(v).slice(0, 25)}`).join(" ") : "";
            return (
              <Text key={ev.id}>
                <Text dimColor>  {ts}  </Text>
                <Text>{ev.type.padEnd(22)}</Text>
                {ev.stage && <Text color="cyan">{ev.stage.padEnd(12)}</Text>}
                <Text dimColor> {data}</Text>
              </Text>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

function AgentList({ agents, selected }: { agents: core.AgentDefinition[]; selected: number }) {
  return (
    <Box flexDirection="column">
      {agents.map((a, i) => (
        <Box key={a.name}>
          <Text bold={i === selected} inverse={i === selected}>
            {i === selected ? " ▸" : "  "} {a.name.padEnd(16)} {a.model.padEnd(8)} T:{a.tools.length} M:{a.mcp_servers.length} S:{a.skills.length} R:{a.memories.length}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function StatusBar({ sessions, tab }: { sessions: core.Session[]; tab: Tab }) {
  const nRun = sessions.filter((s) => s.status === "running").length;
  const nWait = sessions.filter((s) => s.status === "waiting").length;
  const nErr = sessions.filter((s) => s.status === "failed").length;

  return (
    <Box>
      <Text dimColor> {sessions.length} sessions</Text>
      {nRun > 0 && <Text color="blue"> ● {nRun} running</Text>}
      {nWait > 0 && <Text color="yellow"> ⏸ {nWait} waiting</Text>}
      {nErr > 0 && <Text color="red"> ✕ {nErr} errors</Text>}
      <Text dimColor>   j/k:move Enter:dispatch c:done s:stop r:resume n:new q:quit</Text>
    </Box>
  );
}

// ── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const { exit } = useApp();
  const [tab, setTab] = useState<Tab>("sessions");
  const [sel, setSel] = useState(0);

  useRefresh(3000); // auto-refresh

  const sessions = core.listSessions({ limit: 50 });
  const agents = core.listAgents();
  const pipelines = core.listPipelines();

  const items = tab === "sessions" ? sessions :
    tab === "agents" ? agents :
    tab === "pipelines" ? pipelines : [];

  const current = tab === "sessions" && sessions[sel] ? sessions[sel] : null;

  useInput((input, key) => {
    // Tab switching
    if (input === "1") setTab("sessions");
    if (input === "2") setTab("agents");
    if (input === "3") setTab("pipelines");
    if (input === "4") setTab("recipes");
    if (input === "]") {
      const tabs: Tab[] = ["sessions", "agents", "pipelines", "recipes"];
      setTab(tabs[(tabs.indexOf(tab) + 1) % tabs.length]!);
    }
    if (input === "[") {
      const tabs: Tab[] = ["sessions", "agents", "pipelines", "recipes"];
      setTab(tabs[(tabs.indexOf(tab) - 1 + tabs.length) % tabs.length]!);
    }

    // Navigation
    if (input === "j" || key.downArrow) setSel((s) => Math.min(s + 1, items.length - 1));
    if (input === "k" || key.upArrow) setSel((s) => Math.max(s - 1, 0));
    if (input === "G") setSel(items.length - 1);

    // Session actions
    if (tab === "sessions" && current) {
      if (key.return && (current.status === "ready" || current.status === "blocked")) {
        core.dispatch(current.id);
      }
      if (input === "c" && current.status === "running") {
        core.complete(current.id);
      }
      if (input === "s" && current.status !== "completed" && current.status !== "failed") {
        core.stop(current.id);
      }
      if (input === "r" && ["blocked", "waiting", "failed"].includes(current.status)) {
        core.resume(current.id);
      }
    }

    if (input === "q") exit();
  });

  return (
    <Box flexDirection="column" height="100%">
      {/* Tab bar */}
      <TabBar active={tab} />

      {/* Main content: left list + right detail */}
      <Box flexGrow={1} flexDirection="row">
        {/* Left pane — fixed width via string padding */}
        <Box flexDirection="column" width="40%">
          {tab === "sessions" && <SessionList sessions={sessions} selected={sel} />}
          {tab === "agents" && <AgentList agents={agents} selected={sel} />}
          {tab === "pipelines" && (
            <Box flexDirection="column">
              {pipelines.map((p, i) => (
                <Text key={p.name} bold={i === sel} inverse={i === sel}>
                  {i === sel ? " ▸" : "  "} {p.name.padEnd(14)} {p.stages.join(" > ").slice(0, 40)}
                </Text>
              ))}
            </Box>
          )}
        </Box>

        {/* Divider */}
        <Box width={1} flexShrink={0}><Text dimColor>│</Text></Box>

        {/* Right pane */}
        <Box flexDirection="column" flexGrow={1}>
          {tab === "sessions" && <SessionDetail session={current} />}
          {tab === "agents" && agents[sel] && (() => {
            const a = core.loadAgent(agents[sel]!.name);
            if (!a) return null;
            return (
              <Box flexDirection="column">
                <Text bold inverse> {a.name} </Text>
                <Text>  Model: {a.model}  Max turns: {a.max_turns}</Text>
                <Text>  Tools: {a.tools.join(", ")}</Text>
                <Text>  MCPs: {a.mcp_servers.length ? String(a.mcp_servers) : "—"}</Text>
                <Text>  Skills: {a.skills.length ? a.skills.join(", ") : "—"}</Text>
                <Text>  Memories: {a.memories.length ? a.memories.join(", ") : "—"}</Text>
              </Box>
            );
          })()}
          {tab === "pipelines" && pipelines[sel] && (() => {
            const p = core.loadPipeline(pipelines[sel]!.name);
            if (!p) return null;
            return (
              <Box flexDirection="column">
                <Text bold inverse> {p.name} </Text>
                {p.description && <Text dimColor>  {p.description}</Text>}
                {p.stages.map((s, i) => (
                  <Text key={s.name}>
                    {"  "}{i + 1}. {s.name.padEnd(14)} [{s.type ?? (s.action ? "action" : "agent")}:{s.agent ?? s.action ?? ""}] gate={s.gate}
                  </Text>
                ))}
              </Box>
            );
          })()}
        </Box>
      </Box>

      {/* Status bar */}
      <StatusBar sessions={sessions} tab={tab} />
    </Box>
  );
}

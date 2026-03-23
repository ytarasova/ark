import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import * as core from "../../core/index.js";
import { ICON, COLOR } from "../constants.js";
import { ago, hms } from "../helpers.js";
import { SplitPane } from "../components/SplitPane.js";
import { SectionHeader } from "../components/SectionHeader.js";
import type { StoreData } from "../hooks/useStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

interface SessionsTabProps extends StoreData {
  async: AsyncState;
  onShowForm: () => void;
}

export function SessionsTab({ sessions, async: asyncState, onShowForm }: SessionsTabProps) {
  const [sel, setSel] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Top-level sessions only (exclude fork children from list)
  const topLevel = useMemo(() => sessions.filter((s) => !s.parent_id), [sessions]);
  const parentIds = useMemo(
    () => new Set(sessions.filter((s) => s.parent_id).map((s) => s.parent_id)),
    [sessions]
  );

  // Group sessions
  const groups = useMemo(() => {
    const g = new Map<string, core.Session[]>();
    for (const s of topLevel) {
      const name = s.group_name ?? "";
      if (!g.has(name)) g.set(name, []);
      g.get(name)!.push(s);
    }
    return g;
  }, [topLevel]);

  const sortedGroups = useMemo(
    () => [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b))),
    [groups]
  );

  const selected = topLevel[sel] ?? null;

  useInput((input, key) => {
    if (input === "j" || key.downArrow) {
      setSel((s) => Math.min(s + 1, topLevel.length - 1));
    } else if (input === "k" || key.upArrow) {
      setSel((s) => Math.max(s - 1, 0));
    } else if (input === "g") {
      setSel(0);
    } else if (input === "G") {
      setSel(Math.max(0, topLevel.length - 1));
    } else if (key.return) {
      if (selected && (selected.status === "ready" || selected.status === "blocked")) {
        asyncState.run(`Dispatching ${selected.id}`, () =>
          core.dispatch(selected.id).then(() => {})
        );
      }
    } else if (input === "s") {
      if (selected && !["completed", "failed"].includes(selected.status)) {
        asyncState.run(`Stopping ${selected.id}`, async () => {
          core.stop(selected.id);
        });
      }
    } else if (input === "r") {
      if (selected && ["blocked", "waiting", "failed"].includes(selected.status)) {
        asyncState.run(`Resuming ${selected.id}`, () =>
          core.resume(selected.id).then(() => {})
        );
      }
    } else if (input === "c") {
      if (selected && selected.status === "running") {
        asyncState.run(`Completing ${selected.id}`, async () => {
          core.complete(selected.id);
        });
      }
    } else if (input === "x") {
      if (selected) {
        asyncState.run(`Deleting ${selected.id}`, async () => {
          if (selected.session_id) {
            await core.killSessionAsync(selected.session_id);
          }
          core.deleteSession(selected.id);
          setSel((s) => Math.max(0, s - 1));
        });
      }
    } else if (input === "a") {
      if (selected?.session_id) {
        const cmd = core.attachCommand(selected.session_id);
        setStatusMessage(`Run: ${cmd}`);
        setTimeout(() => setStatusMessage(null), 5000);
      }
    } else if (input === "n") {
      onShowForm();
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <SplitPane
        left={<SessionsList
          groups={groups}
          sortedGroups={sortedGroups}
          sessions={sessions}
          parentIds={parentIds}
          sel={sel}
        />}
        right={<SessionDetail session={selected} sessions={sessions} />}
      />
      {statusMessage && (
        <Box>
          <Text color="cyan">{` ${statusMessage}`}</Text>
        </Box>
      )}
    </Box>
  );
}

// ── List ────────────────────────────────────────────────────────────────────

interface SessionsListProps {
  groups: Map<string, core.Session[]>;
  sortedGroups: string[];
  sessions: core.Session[];
  parentIds: Set<string | null>;
  sel: number;
}

function SessionsList({ groups, sortedGroups, sessions, parentIds, sel }: SessionsListProps) {
  let displayIdx = 0;

  if (sortedGroups.length === 0) {
    return <Text dimColor>{"  No sessions. Press n to create."}</Text>;
  }

  return (
    <Box flexDirection="column">
      {sortedGroups.map((groupName) => {
        const items = groups.get(groupName)!;
        return (
          <Box key={groupName || "__ungrouped"} flexDirection="column">
            {groupName ? (
              <Text backgroundColor="gray" color="white">{` ${groupName} `}</Text>
            ) : null}
            {items.map((s) => {
              const idx = displayIdx++;
              const isSel = idx === sel;
              const icon = ICON[s.status] ?? "?";
              const color = (COLOR[s.status] ?? "white") as any;
              const summary = (s.jira_summary ?? s.jira_key ?? s.repo ?? "---").slice(0, 22).padEnd(22);
              const stage = (s.stage ?? "---").padEnd(10);
              const age = ago(s.created_at).padStart(4);
              const marker = isSel ? ">" : " ";

              return (
                <Box key={s.id} flexDirection="column">
                  {isSel ? (
                    <Text bold inverse>
                      {` ${marker} `}<Text color={color}>{icon}</Text>{` ${summary} ${stage} ${age} `}
                    </Text>
                  ) : (
                    <Text>
                      {` ${marker} `}<Text color={color}>{icon}</Text>{` ${summary} ${stage} ${age}`}
                    </Text>
                  )}
                  {parentIds.has(s.id) &&
                    sessions
                      .filter((c) => c.parent_id === s.id)
                      .map((child) => {
                        const ci = ICON[child.status] ?? "?";
                        const cc = (COLOR[child.status] ?? "white") as any;
                        const cs = (child.jira_summary ?? "---").slice(0, 20);
                        return (
                          <Text key={child.id} dimColor>
                            {"   | "}<Text color={cc}>{ci}</Text>{` ${cs}`}
                          </Text>
                        );
                      })}
                </Box>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

interface SessionDetailProps {
  session: core.Session | null;
  sessions: core.Session[];
}

function SessionDetail({ session: s }: SessionDetailProps) {
  if (!s) {
    return <Text dimColor>{"  No session selected"}</Text>;
  }

  // Pipeline bar
  let stages: ReturnType<typeof core.getStages> = [];
  try {
    stages = core.getStages(s.pipeline);
  } catch {
    // ignore — DB may be locked
  }
  let passed = false;

  // Events
  let events: core.Event[] = [];
  try {
    events = core.getEvents(s.id, { limit: 50 });
  } catch {
    // ignore
  }
  const agentReports = events.filter((e) => e.type.startsWith("agent_"));
  const latestReport = agentReports[agentReports.length - 1] ?? null;

  // Agent output
  let agentOutput = "";
  if (s.session_id && s.status === "running") {
    try {
      agentOutput = core.getOutput(s.id, { lines: 15 });
    } catch {
      // ignore
    }
  }

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Text bold>{` ${s.jira_key ?? s.id}  ${s.jira_summary ?? ""}`}</Text>
      <Text>{""}</Text>

      {/* Pipeline bar */}
      <Box>
        <Text>{" "}</Text>
        {stages.map((stg, i) => {
          const isFork = stg.type === "fork";
          const isCurrentStage = stg.name === s.stage;
          let element: React.ReactNode;

          if (isCurrentStage) {
            passed = true;
            const c = (COLOR[s.status] ?? "white") as any;
            element = (
              <Text key={stg.name} color={c} bold>
                {isFork ? "Y" : (ICON[s.status] ?? "●")}{` ${stg.name}`}
              </Text>
            );
          } else if (!passed) {
            element = (
              <Text key={stg.name} color="green">
                {`✓ ${stg.name}`}
              </Text>
            );
          } else {
            element = (
              <Text key={stg.name} dimColor>
                {isFork ? "Y" : "○"}{` ${stg.name}`}
              </Text>
            );
          }

          return (
            <React.Fragment key={stg.name}>
              {element}
              {i < stages.length - 1 && <Text dimColor>{"  >  "}</Text>}
            </React.Fragment>
          );
        })}
      </Box>

      {/* Banners */}
      {s.error && (
        <>
          <Text>{""}</Text>
          <Text color="red" bold>{` ✕ ${s.error}`}</Text>
        </>
      )}
      {s.breakpoint_reason && (
        <>
          <Text>{""}</Text>
          <Text color="yellow" bold>{` ⏸ ${s.breakpoint_reason}`}</Text>
        </>
      )}

      {/* Info */}
      <Text>{""}</Text>
      <SectionHeader title="Info" />
      <Text><Text dimColor>{"  ID".padEnd(13)}</Text>{s.id}</Text>
      <Text>
        <Text dimColor>{"  Status".padEnd(13)}</Text>
        <Text color={(COLOR[s.status] ?? "white") as any}>
          {`${ICON[s.status] ?? "?"} ${s.status}`}
        </Text>
      </Text>
      {s.repo && <Text><Text dimColor>{"  Repo".padEnd(13)}</Text>{s.repo}</Text>}
      {s.branch && <Text><Text dimColor>{"  Branch".padEnd(13)}</Text>{s.branch}</Text>}
      <Text><Text dimColor>{"  Pipeline".padEnd(13)}</Text>{s.pipeline}</Text>
      {s.agent && <Text><Text dimColor>{"  Agent".padEnd(13)}</Text>{s.agent}</Text>}
      {s.group_name && <Text><Text dimColor>{"  Group".padEnd(13)}</Text>{s.group_name}</Text>}

      {/* Channel status */}
      {s.session_id && s.status === "running" && (
        <Text color="green">
          {`  ⚡ Channel: port ${core.sessionChannelPort(s.id)}`}
        </Text>
      )}

      {/* Latest agent report */}
      {latestReport && (() => {
        const d = latestReport.data ?? {};
        const reportType = latestReport.type.replace("agent_", "");
        const reportColor = (
          reportType === "completed" ? "green"
          : reportType === "error" ? "red"
          : reportType === "question" ? "yellow"
          : "cyan"
        ) as any;
        const message = String(d.message ?? d.summary ?? d.question ?? d.error ?? "").slice(0, 80);
        return (
          <>
            <Text>{""}</Text>
            <SectionHeader title="Latest Report" />
            <Text>
              {"  "}<Text color={reportColor}>{reportType}</Text>{`: ${message}`}
            </Text>
          </>
        );
      })()}

      {/* Agent output */}
      {agentOutput.trim() ? (
        <>
          <Text>{""}</Text>
          <SectionHeader title="Agent Output" />
          {agentOutput.split("\n").slice(-12).map((line, i) => (
            <Text key={i}>{`  ${line.slice(0, 80)}`}</Text>
          ))}
        </>
      ) : !s.session_id && (s.status === "ready" || s.status === "blocked") ? (
        <>
          <Text>{""}</Text>
          <Text dimColor>{" Press Enter to dispatch agent"}</Text>
        </>
      ) : null}

      {/* Events */}
      {events.length > 0 && (
        <>
          <Text>{""}</Text>
          <SectionHeader title="Events" />
          {events.slice(-10).map((ev, i) => {
            const ts = hms(ev.created_at);
            const data = ev.data
              ? Object.entries(ev.data)
                  .slice(0, 2)
                  .map(([k, v]) => `${k}=${String(v).slice(0, 20)}`)
                  .join(" ")
              : "";
            return (
              <Text key={i}>
                {"  "}<Text dimColor>{ts}</Text>{"  "}
                {ev.type.padEnd(20)}
                <Text color="cyan">{` ${(ev.stage ?? "").padEnd(10)}`}</Text>
                <Text dimColor>{` ${data}`}</Text>
              </Text>
            );
          })}
        </>
      )}
    </Box>
  );
}

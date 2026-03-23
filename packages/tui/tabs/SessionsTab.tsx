import React, { useState, useMemo, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import * as core from "../../core/index.js";
import { ICON, COLOR } from "../constants.js";
import { ago, hms } from "../helpers.js";
import { formatEvent } from "../helpers/formatEvent.js";
import { SplitPane } from "../components/SplitPane.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { TreeList } from "../components/TreeList.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { KeyValue } from "../components/KeyValue.js";
import { SelectMenu } from "../components/SelectMenu.js";
import { TextInputEnhanced } from "../components/TextInputEnhanced.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import { useAgentOutput } from "../hooks/useAgentOutput.js";
import type { StoreData } from "../hooks/useStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

interface SessionsTabProps extends StoreData {
  async: AsyncState;
  pane: "left" | "right";
  onShowForm: () => void;
  onSelectionChange?: (session: any) => void;
  formOverlay?: React.ReactNode;
  refresh: () => void;
}

export function SessionsTab({ sessions, refreshing, refresh, pane, async: asyncState, onShowForm, onSelectionChange, formOverlay }: SessionsTabProps) {
  const [moveMode, setMoveMode] = useState(false);
  const status = useStatusMessage();

  // Top-level sessions only (exclude fork children from list)
  const topLevel = useMemo(() => sessions.filter((s) => !s.parent_id), [sessions]);

  const { sel, setSel } = useListNavigation(topLevel.length, { active: pane === "left" && !formOverlay && !moveMode });

  const selected = topLevel[sel] ?? null;

  // Notify parent of selection/pane changes for status bar
  useEffect(() => {
    onSelectionChange?.(selected);
  }, [selected?.id, selected?.status]);

  // Helper: get all sessions in the same group as selected
  const selectedGroup = selected?.group_name ?? "";
  const groupSessions = useMemo(
    () => topLevel.filter(s => (s.group_name ?? "") === selectedGroup),
    [topLevel, selectedGroup],
  );

  useInput((input, key) => {
    // Don't handle keys when form overlay is active (form owns input)
    if (formOverlay) return;
    if (moveMode) return; // let SelectMenu handle input

    if (key.return) {
      if (selected && (selected.status === "ready" || selected.status === "blocked")) {
        asyncState.run(`Dispatching ${selected.id}`, async () => {
          await core.dispatch(selected.id);
          refresh();
        });
      } else if (selected && selected.status === "failed") {
        asyncState.run(`Retrying ${selected.id}`, async () => {
          await core.resume(selected.id);
          refresh();
        });
      }
    } else if (input === "s") {
      if (selected && !["completed", "failed"].includes(selected.status)) {
        asyncState.run(`Stopping ${selected.id}`, async () => {
          core.stop(selected.id);
          refresh();
        });
      }
    } else if (input === "r") {
      if (selected && ["blocked", "waiting", "failed"].includes(selected.status)) {
        asyncState.run(`Resuming ${selected.id}`, async () => {
          await core.resume(selected.id);
          refresh();
        });
      }
    } else if (input === "c") {
      if (selected && selected.status === "running") {
        asyncState.run(`Completing ${selected.id}`, async () => {
          core.complete(selected.id);
          refresh();
        });
      }
    } else if (input === "x") {
      if (selected) {
        asyncState.run(`Deleting ${selected.id}`, async () => {
          if (selected.session_id) {
            await core.killSessionAsync(selected.session_id);
          }
          core.deleteSession(selected.id);
          refresh();
        });
      }
    } else if (input === "a") {
      if (selected?.session_id) {
        // Verify tmux session exists
        if (!core.sessionExists(selected.session_id)) {
          status.show(`No active tmux session for ${selected.id}. Try re-dispatching.`);
          return;
        }
        // Attach: mute Ink, reset terminal for tmux, spawn+wait, restore Ink
        const sid = selected.session_id;
        const origWrite = process.stdout.write.bind(process.stdout);
        const origErrWrite = process.stderr.write.bind(process.stderr);
        process.stdout.write = (() => true) as any;
        process.stderr.write = (() => true) as any;
        setTimeout(() => {
          process.stdout.write = origWrite;
          process.stderr.write = origErrWrite;
          // Reset terminal state so tmux gets a clean terminal
          try { process.stdin.setRawMode(false); } catch {}
          process.stdout.write("\x1b[?1049l"); // exit alt screen if active
          process.stdout.write("\x1b[?25h");    // show cursor
          // Spawn tmux as child, block until detach
          const result = Bun.spawnSync(["tmux", "attach", "-t", sid], {
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
            env: { ...process.env, TERM: "xterm-256color" },
          });
          // Restore terminal for Ink
          try { process.stdin.setRawMode(true); } catch {}
          process.stdout.write("\x1b[?25l");      // hide cursor
          process.stdout.write("\x1b[2J\x1b[H");  // clear screen
          status.show("Detached from session");
        }, 100);
      }
    } else if (input === "m") {
      if (selected) setMoveMode(true);
    } else if (input === "S") {
      if (selectedGroup && groupSessions.length > 0) {
        asyncState.run(`Stopping group '${selectedGroup}'`, async () => {
          for (const s of groupSessions) {
            if (!["completed", "failed"].includes(s.status)) core.stop(s.id);
          }
          refresh();
        });
      }
    } else if (input === "R") {
      if (selectedGroup && groupSessions.length > 0) {
        asyncState.run(`Resuming group '${selectedGroup}'`, async () => {
          for (const s of groupSessions) {
            if (["blocked", "waiting", "failed"].includes(s.status)) await core.resume(s.id);
          }
          refresh();
        });
      }
    } else if (input === "X") {
      if (selectedGroup && groupSessions.length > 0) {
        asyncState.run(`Deleting group '${selectedGroup}'`, async () => {
          for (const s of groupSessions) {
            if (s.session_id) await core.killSessionAsync(s.session_id);
            core.deleteSession(s.id);
          }
          setSel(0);
          refresh();
        });
      }
    } else if (input === "n") {
      onShowForm();
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      {refreshing && <Text><Spinner type="dots" /> <Text dimColor>refreshing...</Text></Text>}
      <SplitPane
        focus={pane}
        leftTitle="Sessions"
        rightTitle="Details"
        left={
          <TreeList
            items={topLevel}
            groupBy={s => s.group_name ?? ""}
            renderRow={(s, selected) => {
              const icon = ICON[s.status] ?? "?";
              const summary = (s.summary ?? s.ticket ?? s.repo ?? "---").slice(0, 22).padEnd(22);
              const stage = (s.stage ?? "---").padEnd(10);
              const age = ago(s.created_at).padStart(4);
              const marker = topLevel.indexOf(s) === sel ? ">" : " ";
              return ` ${marker} ${icon} ${summary} ${stage} ${age}`;
            }}
            renderColoredRow={(s) => {
              const icon = ICON[s.status] ?? "?";
              const color = (COLOR[s.status] ?? "white") as any;
              const summary = (s.summary ?? s.ticket ?? s.repo ?? "---").slice(0, 22).padEnd(22);
              const stage = (s.stage ?? "---").padEnd(10);
              const age = ago(s.created_at).padStart(4);
              return <Text>{" "} <Text color={color}>{icon}</Text>{` ${summary} ${stage} ${age}`}</Text>;
            }}
            renderChildren={(s) => {
              // fork children
              const children = sessions.filter(c => c.parent_id === s.id);
              if (children.length === 0) return null;
              return children.map(child => {
                const ci = ICON[child.status] ?? "?";
                const cc = (COLOR[child.status] ?? "white") as any;
                const cs = (child.summary ?? "---").slice(0, 20);
                return <Text key={child.id} dimColor>{"   | "}<Text color={cc}>{ci}</Text>{` ${cs}`}</Text>;
              });
            }}
            sel={sel}
            emptyMessage="No sessions. Press n to create."
          />
        }
        right={
          formOverlay ? formOverlay
          : moveMode ? (
            <MoveToGroup
              session={selected}
              onDone={(group) => {
                if (selected && group !== undefined) {
                  core.updateSession(selected.id, { group_name: group || null });
                  status.show(group ? `Moved to '${group}'` : "Removed from group");
                  refresh();
                }
                setMoveMode(false);
              }}
            />
          )
          : <SessionDetail session={selected} sessions={sessions} pane={pane} />
        }
      />
      {status.message && (
        <Box>
          <Text color="cyan">{` ${status.message}`}</Text>
        </Box>
      )}
    </Box>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

interface SessionDetailProps {
  session: core.Session | null;
  sessions: core.Session[];
  pane: "left" | "right";
}

function SessionDetail({ session: s, pane }: SessionDetailProps) {
  if (!s) {
    return <Text dimColor>{"  No session selected"}</Text>;
  }

  // Flow bar
  let stages: ReturnType<typeof core.getStages> = [];
  try {
    stages = core.getStages(s.flow);
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
  // Agent output - live polling via hook
  const agentOutput = useAgentOutput(
    s.id,
    s.session_id,
    s.status === "running",
    500, // refresh every 500ms for near-real-time
  );

  return (
    <DetailPanel active={pane === "right"}>
      {/* Header */}
      <Text bold>{` ${s.ticket ?? s.id}  ${s.summary ?? ""}`}</Text>
      <Text> </Text>

      {/* Flow bar — only show for multi-stage flows */}
      {stages.length > 1 && <Box>
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
      </Box>}

      {/* Status line — single source of truth */}
      <Text> </Text>
      <Text color={(COLOR[s.status] ?? "white") as any} bold>
        {` ${ICON[s.status] ?? "?"} ${s.error ? s.error : s.status}`}
      </Text>
      {s.breakpoint_reason && (
        <Text color="yellow" bold>{` ⏸ ${s.breakpoint_reason}`}</Text>
      )}

      {/* Info */}
      <Text> </Text>
      <SectionHeader title="Info" />
      <KeyValue label="ID">{s.id}</KeyValue>
      <KeyValue label="Compute">{s.compute_name || "local"}</KeyValue>
      {s.repo && <KeyValue label="Repo">{s.repo}</KeyValue>}
      {s.branch && <KeyValue label="Branch">{s.branch}</KeyValue>}
      {s.workdir && s.workdir !== s.repo && (
        <KeyValue label="Workdir">{s.workdir}</KeyValue>
      )}
      {(s.config as any)?.remoteWorkdir && (
        <KeyValue label="Remote">{(s.config as any).remoteWorkdir}</KeyValue>
      )}
      <KeyValue label="Flow">{s.flow}</KeyValue>
      {s.agent && <KeyValue label="Agent">{s.agent}</KeyValue>}
      {s.group_name && <KeyValue label="Group">{s.group_name}</KeyValue>}

      {/* Channel status */}
      {s.session_id && s.status === "running" && (
        <Text color="green">
          {`  ⚡ Channel: port ${core.sessionChannelPort(s.id)}`}
        </Text>
      )}

      {/* Agent output (live tmux capture) */}
      {agentOutput.trim() ? (
        <>
          <Text> </Text>
          <SectionHeader title="Live Output" />
          {agentOutput.split("\n").slice(-12).map((line, i) => (
            <Text key={i} wrap="truncate">{`  ${line}`}</Text>
          ))}
        </>
      ) : !s.session_id && (s.status === "ready" || s.status === "blocked") ? (
        <>
          <Text> </Text>
          <Text dimColor>{" Press Enter to dispatch agent"}</Text>
        </>
      ) : null}

      {/* Events - visual separator */}
      {events.length > 0 && (
        <>
          <Text> </Text>
          <Text dimColor>{"  " + "─".repeat(50)}</Text>
          <Text> </Text>
          <SectionHeader title="Events" />
          {events.slice(-10).map((ev, i) => {
            const ts = hms(ev.created_at).slice(0, 5); // HH:MM
            const msg = formatEvent(ev.type, ev.data ?? undefined);
            return (
              <Text key={i}>
                {"  "}<Text dimColor>{ts}</Text>{"  "}
                {msg}
              </Text>
            );
          })}
        </>
      )}
    </DetailPanel>
  );
}

// ── Move to Group ──────────────────────────────────────────────────────────

interface MoveToGroupProps {
  session: core.Session | null;
  onDone: (group: string | undefined) => void;
}

function MoveToGroup({ session, onDone }: MoveToGroupProps) {
  const [newGroup, setNewGroup] = useState("");
  const [mode, setMode] = useState<"pick" | "new">("pick");
  const existing = core.getGroups();

  useInput((input, key) => {
    if (key.escape) onDone(undefined);
  });

  const choices = [
    ...existing.map(g => ({ label: g, value: g })),
    { label: "(none) — remove from group", value: "__none__" },
    { label: "+ New group...", value: "__new__" },
  ];

  if (mode === "new") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
        <Text bold color="cyan">{" Move to Group "}</Text>
        <Text> </Text>
        <Text>{`Session: ${session?.summary ?? session?.id}`}</Text>
        <Text> </Text>
        <Text>{"New group name:"}</Text>
        <Box>
          <Text color="cyan">{"> "}</Text>
          <TextInputEnhanced
            value={newGroup}
            onChange={setNewGroup}
            onSubmit={() => { if (newGroup.trim()) onDone(newGroup.trim()); }}
            placeholder="Enter group name..."
          />
        </Box>
        <Text dimColor>{"  Enter to confirm, Esc to cancel"}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold color="cyan">{" Move to Group "}</Text>
      <Text> </Text>
      <Text>{`Session: ${session?.summary ?? session?.id}`}</Text>
      <Text> </Text>
      <SelectMenu
        items={choices}
        onSelect={(item) => {
          if (item.value === "__new__") {
            setMode("new");
          } else if (item.value === "__none__") {
            onDone("");
          } else {
            onDone(item.value);
          }
        }}
      />
      <Text dimColor>{"  Esc to cancel"}</Text>
    </Box>
  );
}

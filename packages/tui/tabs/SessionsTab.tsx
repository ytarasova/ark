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
  const [groupMode, setGroupMode] = useState<false | "menu">(false);
  const [talkMode, setTalkMode] = useState(false);
  const status = useStatusMessage();

  // Top-level sessions only (exclude fork children from list)
  const topLevel = useMemo(() => sessions.filter((s) => !s.parent_id), [sessions]);

  const { sel, setSel } = useListNavigation(topLevel.length, { active: pane === "left" && !formOverlay && !moveMode && !groupMode && !talkMode });

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
    if (moveMode || groupMode || talkMode) return; // let overlay handle input

    if (key.return) {
      if (selected && (selected.status === "ready" || selected.status === "blocked")) {
        asyncState.run(`Dispatching ${selected.id}`, async () => {
          await core.dispatch(selected.id);
          refresh();
        });
      } else if (selected && (selected.status === "failed" || selected.status === "stopped")) {
        asyncState.run(`Restarting ${selected.id}`, async () => {
          await core.resume(selected.id);
          refresh();
        });
      }
    } else if (input === "s") {
      if (selected && !["completed", "failed", "stopped"].includes(selected.status)) {
        asyncState.run(`Stopping ${selected.id}`, async () => {
          core.stop(selected.id);
          refresh();
        });
      }
    } else if (input === "r") {
      if (selected && ["blocked", "failed", "stopped"].includes(selected.status)) {
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
    } else if (input === "t") {
      if (selected?.status === "running") setTalkMode(true);
    } else if (input === "g") {
      setGroupMode("menu");
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
            if (["blocked", "waiting", "failed", "stopped"].includes(s.status)) await core.resume(s.id);
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
            emptyGroups={core.getGroups()}
            renderRow={(s, selected) => {
              const icon = ICON[s.status] ?? "?";
              const summary = (s.summary ?? s.ticket ?? s.repo ?? "---").slice(0, 22).padEnd(22);
              const stage = (s.stage ? `stage:${s.stage}` : "---").padEnd(14);
              const age = ago(s.created_at).padStart(4);
              const marker = topLevel.indexOf(s) === sel ? ">" : " ";
              const unread = core.getUnreadCount(s.id);
              const badge = unread > 0 ? ` (${unread})` : "";
              return ` ${marker} ${icon} ${summary} ${stage} ${age}${badge}`;
            }}
            renderColoredRow={(s) => {
              const icon = ICON[s.status] ?? "?";
              const color = (COLOR[s.status] ?? "white") as any;
              const summary = (s.summary ?? s.ticket ?? s.repo ?? "---").slice(0, 22).padEnd(22);
              const stage = (s.stage ? `stage:${s.stage}` : "---").padEnd(14);
              const age = ago(s.created_at).padStart(4);
              const unread = core.getUnreadCount(s.id);
              return (
                <Text>
                  {" "} <Text color={color}>{icon}</Text>{` ${summary} ${stage} ${age}`}
                  {unread > 0 && <Text color="yellow" bold>{` (${unread})`}</Text>}
                </Text>
              );
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
          asyncState.loading && asyncState.label ? (
            <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
              <Text color="yellow"><Spinner type="dots" />{` ${asyncState.label}`}</Text>
            </Box>
          )
          : formOverlay ? formOverlay
          : talkMode ? (
            <TalkToSession
              session={selected}
              onDone={(msg) => {
                if (msg) status.show(msg);
                setTalkMode(false);
              }}
            />
          )
          : groupMode ? (
            <GroupManager
              sessions={topLevel}
              onDone={(msg) => {
                if (msg) { status.show(msg); refresh(); }
                setGroupMode(false);
              }}
            />
          )
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
    s.status === "running" || s.status === "waiting",
    500, // refresh every 500ms for near-real-time
  );

  return (
    <DetailPanel active={pane === "right"}>
      {/* Info */}
      <SectionHeader title="Info" />
      <KeyValue label="Session">{`${s.id}  ${s.summary ?? ""}`}</KeyValue>
      <KeyValue label="Status">
        <Text color={(COLOR[s.status] ?? "white") as any} bold>
          {`${ICON[s.status] ?? "?"} ${s.error ? s.error : s.status}`}
        </Text>
      </KeyValue>
      {s.breakpoint_reason && (
        <KeyValue label=""><Text color="yellow" bold>{`⏸ ${s.breakpoint_reason}`}</Text></KeyValue>
      )}
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
      {s.stage && <KeyValue label="Stage">{s.stage}</KeyValue>}
      {s.agent && <KeyValue label="Agent">{s.agent}</KeyValue>}
      {s.group_name && <KeyValue label="Group">{s.group_name}</KeyValue>}

      {/* Channel status */}
      {s.session_id && (s.status === "running" || s.status === "waiting") && (
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
      <Box flexDirection="column" flexGrow={1}>
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
            onSubmit={() => { if (newGroup.trim()) { core.createGroup(newGroup.trim()); onDone(newGroup.trim()); } }}
            placeholder="Enter group name..."
          />
        </Box>
        <Box flexGrow={1} /><Text dimColor>{"  Enter to confirm, Esc to cancel"}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
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
      <Box flexGrow={1} /><Text dimColor>{"  Esc to cancel"}</Text>
    </Box>
  );
}

// ── Group Manager ──────────────────────────────────────────────────────────

interface GroupManagerProps {
  sessions: core.Session[];
  onDone: (message?: string) => void;
}

function GroupManager({ sessions, onDone }: GroupManagerProps) {
  const [action, setAction] = useState<"menu" | "create" | "delete">("menu");
  const [newName, setNewName] = useState("");
  const existing = core.getGroups();

  useInput((input, key) => {
    if (key.escape) {
      if (action !== "menu") { setAction("menu"); return; }
      onDone();
    }
  });

  if (action === "create") {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text bold color="cyan">{" Create Group "}</Text>
        <Text> </Text>
        <Text>{"Group name:"}</Text>
        <Box>
          <Text color="cyan">{"> "}</Text>
          <TextInputEnhanced
            value={newName}
            onChange={setNewName}
            onSubmit={() => {
              if (!newName.trim()) return;
              core.createGroup(newName.trim());
              onDone(`Group '${newName.trim()}' created`);
            }}
            placeholder="Enter group name..."
          />
        </Box>
        <Box flexGrow={1} /><Text dimColor>{"  Enter to create, Esc to go back"}</Text>
      </Box>
    );
  }

  if (action === "delete") {
    const deleteChoices = existing.map(g => {
      const count = sessions.filter(s => s.group_name === g).length;
      return { label: `${g} (${count} session${count !== 1 ? "s" : ""})`, value: g };
    });

    if (deleteChoices.length === 0) {
      return (
        <Box flexDirection="column" flexGrow={1}>
          <Text bold color="cyan">{" Delete Group "}</Text>
          <Text> </Text>
          <Text dimColor>{"  No groups to delete."}</Text>
          <Box flexGrow={1} /><Text dimColor>{"  Esc to go back"}</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text bold color="red">{" Delete Group "}</Text>
        <Text> </Text>
        <Text>{"Select group to delete:"}</Text>
        <SelectMenu
          items={deleteChoices}
          onSelect={async (item) => {
            // Kill and delete all sessions in the group
            const groupSessions = sessions.filter(s => s.group_name === item.value);
            for (const s of groupSessions) {
              if (s.session_id) {
                try { await core.killSessionAsync(s.session_id); } catch {}
              }
              core.deleteSession(s.id);
            }
            // Delete the group itself
            core.deleteGroup(item.value);
            onDone(`Deleted group '${item.value}' (${groupSessions.length} sessions removed)`);
          }}
        />
        <Box flexGrow={1} /><Text dimColor>{"  Esc to go back"}</Text>
      </Box>
    );
  }

  // Menu
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color="cyan">{" Groups "}</Text>
      <Text> </Text>
      <SelectMenu
        items={[
          { label: "Create new group", value: "create" },
          { label: "Delete group", value: "delete" },
        ]}
        onSelect={(item) => setAction(item.value as any)}
      />
      {existing.length > 0 && (
        <>
          <Text> </Text>
          <Text dimColor>{"  Existing groups:"}</Text>
          {existing.map(g => {
            const count = sessions.filter(s => s.group_name === g).length;
            return <Text key={g} dimColor>{`    ${g} (${count})`}</Text>;
          })}
        </>
      )}
      <Text> </Text>
      <Box flexGrow={1} /><Text dimColor>{"  Esc to cancel"}</Text>
    </Box>
  );
}

// ── Talk to Session ────────────────────────────────────────────────────────

interface TalkToSessionProps {
  session: core.Session | null;
  onDone: (message?: string) => void;
}

function TalkToSession({ session, onDone }: TalkToSessionProps) {
  const [msg, setMsg] = useState("");
  const [messages, setMessages] = useState<core.Message[]>([]);

  // Load messages and mark as read
  useEffect(() => {
    if (!session) return;
    const load = () => {
      setMessages(core.getMessages(session.id, { limit: 20 }));
    };
    load();
    core.markMessagesRead(session.id);
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [session?.id]);

  useInput((input, key) => {
    if (key.escape) onDone();
  });

  if (!session) {
    onDone();
    return null;
  }

  const channelPort = core.sessionChannelPort(session.id);

  const send = async () => {
    if (!msg.trim()) return;
    // Store outbound message
    core.addMessage({ session_id: session.id, role: "user", content: msg.trim() });
    setMessages(core.getMessages(session.id, { limit: 20 }));
    const text = msg.trim();
    setMsg("");
    try {
      await fetch(`http://localhost:${channelPort}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "steer",
          sessionId: session.id,
          message: text,
          from: "user",
        }),
      });
    } catch {
      core.addMessage({ session_id: session.id, role: "system", content: `Failed to deliver (port ${channelPort})`, type: "error" });
      setMessages(core.getMessages(session.id, { limit: 20 }));
    }
  };

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color="cyan">{` Chat: ${session.summary ?? session.id} `}</Text>
      <Text> </Text>

      {/* Message history */}
      <Box flexDirection="column" flexGrow={1}>
        {messages.length === 0 && (
          <Text dimColor>{"  No messages yet. Type below to send."}</Text>
        )}
        {messages.map((m) => {
          const ts = m.created_at.slice(11, 16);
          const roleColor = m.role === "user" ? "cyan" : m.role === "agent" ? "green" : "gray";
          const typeTag = m.type !== "text" ? ` [${m.type}]` : "";
          return (
            <Text key={m.id} wrap="truncate">
              <Text dimColor>{`  ${ts} `}</Text>
              <Text color={roleColor as any} bold>{m.role === "user" ? "you" : "agent"}</Text>
              {typeTag && <Text dimColor>{typeTag}</Text>}
              <Text>{` ${m.content}`}</Text>
            </Text>
          );
        })}
      </Box>

      {/* Input */}
      <Box>
        <Text color="cyan">{"> "}</Text>
        <TextInputEnhanced
          value={msg}
          onChange={setMsg}
          onSubmit={send}
          focus={true}
          placeholder="Type a message..."
        />
      </Box>
      <Text dimColor>{"  Enter:send  Esc:back"}</Text>
    </Box>
  );
}

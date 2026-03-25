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
import { ThreadsPanel } from "../components/ThreadsPanel.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useSessionActions } from "../hooks/useSessionActions.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import { useAgentOutput } from "../hooks/useAgentOutput.js";
import type { StoreData } from "../hooks/useStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

interface SessionsTabProps extends StoreData {
  async: AsyncState;
  pane: "left" | "right";
  onShowForm: () => void;
  onSelectionChange?: (session: any) => void;
  onInputActive?: (active: boolean) => void;
  onOverlayChange?: (overlay: string | null) => void;
  onListLength?: (length: number) => void;
  formOverlay?: React.ReactNode;
  refresh: () => void;
}

export function SessionsTab({ sessions, refreshing, refresh, pane, unreadCounts, async: asyncState, onShowForm, onSelectionChange, onInputActive, onOverlayChange, onListLength, formOverlay }: SessionsTabProps) {
  const [moveMode, setMoveMode] = useState(false);
  const [groupMode, setGroupMode] = useState<false | "menu">(false);
  const [talkMode, setTalkMode] = useState(false);
  const [inboxMode, setInboxMode] = useState(false);
  const [cloneMode, setCloneMode] = useState(false);
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<core.SearchResult[] | null>(null);
  const status = useStatusMessage();

  // Top-level sessions only (exclude fork children from list)
  const topLevel = useMemo(() => sessions.filter((s) => !s.parent_id), [sessions]);

  const hasOverlay = formOverlay || moveMode || groupMode || talkMode || inboxMode || cloneMode || searchMode;
  const { sel, setSel } = useListNavigation(topLevel.length, { active: pane === "left" && !hasOverlay });

  // Signal parent when an overlay with text input is active
  useEffect(() => {
    onInputActive?.(!!hasOverlay);
  }, [!!hasOverlay]);

  // Signal parent which overlay is active (for status bar hints)
  useEffect(() => {
    const ov = moveMode ? "move" : talkMode ? "talk" : groupMode ? "group" : inboxMode ? "inbox" : cloneMode ? "clone" : searchMode ? "search" : null;
    onOverlayChange?.(ov);
  }, [moveMode, talkMode, groupMode, inboxMode, cloneMode, searchMode]);

  const selected = topLevel[sel] ?? null;

  // Report list length for conditional scroll hints
  useEffect(() => { onListLength?.(topLevel.length); }, [topLevel.length]);

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

  // Memoize group list — depends on sessions (groups derived from session group_names + groups table)
  const groups = useMemo(() => core.getGroups(), [sessions]);

  const actions = useSessionActions(asyncState);

  useInput((input, key) => {
    if (formOverlay || hasOverlay) return;

    // Global keys — work regardless of selection
    if (input === "n") { onShowForm(); return; }
    if (input === "i") { setInboxMode(true); return; }
    if (input === "o") { setGroupMode("menu"); return; }

    // Cancel pending confirm on any non-d key
    if (confirmComplete && input !== "d") {
      setConfirmComplete(false);
      status.clear();
    }

    // Everything below requires a selected session
    if (!selected) return;

    if (key.return) {
      if (selected.status === "ready" || selected.status === "blocked") {
        actions.dispatch(selected.id);
      } else if (["failed", "stopped", "completed"].includes(selected.status)) {
        actions.restart(selected.id);
      }
    } else if (input === "s") {
      if (!["completed", "failed", "stopped"].includes(selected.status)) {
        actions.stop(selected.id);
      }
    } else if (input === "r") {
      if (["blocked", "failed", "stopped", "completed"].includes(selected.status)) {
        actions.restart(selected.id);
      }
    } else if (input === "c") {
      if (selected) setCloneMode(true);
    } else if (input === "x") {
      actions.delete(selected.id);
    } else if (input === "a") {
      if (selected?.session_id) {
        const sid = selected.session_id;
        const selectedId = selected.id;
        asyncState.run("Checking session...", async () => {
          const exists = await core.sessionExistsAsync(sid);
          if (!exists) {
            status.show(`No active tmux session for ${selectedId}. Try re-dispatching.`);
            return;
          }
          // Attach: mute Ink, reset terminal for tmux, spawn+wait, restore Ink
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
        });
      }
    } else if (input === "m") {
      if (selected) setMoveMode(true);
    } else if (input === "d") {
      if (selected && selected.status === "running") {
        if (confirmComplete) {
          actions.complete(selected.id);
          setConfirmComplete(false);
        } else {
          setConfirmComplete(true);
          status.show(`Done with '${selected.summary ?? selected.id}'? Press d again to confirm`);
        }
      }
    } else if (input === "t") {
      if (selected?.status === "running" || selected?.status === "waiting") setTalkMode(true);
    } else if (input === "S") {
      if (selectedGroup && groupSessions.length > 0) {
        actions.stopGroup(groupSessions);
      }
    } else if (input === "R") {
      if (selectedGroup && groupSessions.length > 0) {
        actions.resumeGroup(groupSessions);
      }
    } else if (input === "X") {
      if (selectedGroup && groupSessions.length > 0) {
        actions.deleteGroup(groupSessions);
        setSel(0);
      }
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
            emptyGroups={groups}
            renderRow={(s, selected) => {
              const icon = ICON[s.status] ?? "?";
              const summary = (s.summary ?? s.ticket ?? s.repo ?? "---").slice(0, 22).padEnd(22);
              const stage = (s.stage ? `stage:${s.stage}` : "---").padEnd(14);
              const age = ago(s.created_at).padStart(4);
              const marker = topLevel.indexOf(s) === sel ? ">" : " ";
              const unread = unreadCounts.get(s.id) ?? 0;
              const badge = unread > 0 ? ` (${unread})` : "";
              return ` ${marker} ${icon} ${summary} ${stage} ${age}${badge}`;
            }}
            renderColoredRow={(s) => {
              const icon = ICON[s.status] ?? "?";
              const color = (COLOR[s.status] ?? "white") as any;
              const summary = (s.summary ?? s.ticket ?? s.repo ?? "---").slice(0, 22).padEnd(22);
              const stage = (s.stage ? `stage:${s.stage}` : "---").padEnd(14);
              const age = ago(s.created_at).padStart(4);
              const unread = unreadCounts.get(s.id) ?? 0;
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
          formOverlay ? formOverlay
          : cloneMode ? (
            <CloneSession
              session={selected}
              onDone={(name) => {
                setCloneMode(false);
                if (!selected || !name) return;
                actions.clone(selected.id, name, selected.group_name);
              }}
            />
          )
          : inboxMode ? (
            <ThreadsPanel
              sessions={topLevel}
              onDone={() => { setInboxMode(false); refresh(); }}
            />
          )
          : talkMode ? (
            <TalkToSession
              session={selected}
              asyncState={asyncState}
              onDone={(msg) => {
                if (msg) status.show(msg);
                setTalkMode(false);
              }}
            />
          )
          : groupMode ? (
            <GroupManager
              sessions={topLevel}
              asyncState={asyncState}
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
                  asyncState.run("Moving session...", () => {
                    core.updateSession(selected.id, { group_name: group || null });
                    status.show(group ? `Moved to '${group}'` : "Removed from group");
                    refresh();
                  });
                }
                setMoveMode(false);
              }}
            />
          )
          : <SessionDetail
              session={selected}
              sessions={sessions}
              pane={pane}
              searchMode={searchMode}
              searchQuery={searchQuery}
              searchResults={searchResults}
              onSearchToggle={(on) => {
                setSearchMode(on);
                if (!on) { setSearchQuery(""); setSearchResults(null); }
              }}
              onSearchQueryChange={setSearchQuery}
              onSearchSubmit={(q) => {
                if (!selected || !q.trim()) return;
                const convId = selected.claude_session_id || selected.id;
                const results = core.searchSessionConversation(convId, q.trim());
                setSearchResults(results);
              }}
            />
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
  searchMode: boolean;
  searchQuery: string;
  searchResults: core.SearchResult[] | null;
  onSearchToggle: (on: boolean) => void;
  onSearchQueryChange: (q: string) => void;
  onSearchSubmit: (q: string) => void;
}

function SessionDetail({ session: s, pane, searchMode, searchQuery, searchResults, onSearchToggle, onSearchQueryChange, onSearchSubmit }: SessionDetailProps) {
  const [events, setEvents] = useState<core.Event[]>([]);
  const [conversation, setConversation] = useState<{ role: string; content: string; timestamp: string }[]>([]);

  useEffect(() => {
    if (!s) { setEvents([]); return; }
    try {
      setEvents(core.getEvents(s.id, { limit: 50 }));
    } catch {
      setEvents([]);
    }
  }, [s?.id, s?.status]);

  // Load conversation history from FTS5
  useEffect(() => {
    if (!s) { setConversation([]); return; }
    const convId = s.claude_session_id || s.id;
    try {
      setConversation(core.getSessionConversation(convId, { limit: 100 }));
    } catch {
      setConversation([]);
    }
  }, [s?.id, s?.claude_session_id, s?.status]);

  const channelPort = useMemo(() => s ? core.sessionChannelPort(s.id) : 0, [s?.id]);

  // Search mode: / to enter, Esc to exit
  useInput((input, key) => {
    if (pane !== "right") return;
    if (searchMode) {
      if (key.escape) onSearchToggle(false);
      return;
    }
    if (input === "/") onSearchToggle(true);
  });

  // Hooks must be called unconditionally (before any early return)
  const agentOutput = useAgentOutput(
    s?.id ?? null,
    s?.session_id ?? null,
    s?.status === "running" || s?.status === "waiting",
    500,
  );

  if (!s) {
    return <Box flexGrow={1}><Text dimColor>{"  No session selected"}</Text></Box>;
  }

  return (
    <DetailPanel active={pane === "right"}>
      {/* Search bar */}
      {searchMode && (
        <Box marginBottom={1}>
          <Text color="cyan">{" / "}</Text>
          <TextInputEnhanced
            value={searchQuery}
            onChange={onSearchQueryChange}
            onSubmit={(q: string) => onSearchSubmit(q)}
            focus={true}
            placeholder="Search conversation..."
          />
        </Box>
      )}

      {/* Info */}
      <SectionHeader title="Info" />
      <KeyValue label="Session">{`${s.id}  ${s.summary ?? ""}`}</KeyValue>
      <KeyValue label="Status">
        <Text color={(COLOR[s.status] ?? "white") as any} bold>
          {`${ICON[s.status] ?? "?"} ${s.error ? s.error : s.status}`}
        </Text>
      </KeyValue>
      {s.status === "completed" && (
        <>
          <Text color="green" bold>{`  ✓ Agent completed successfully`}</Text>
          {(s.config as any)?.completion_summary && (
            <Text color="green" wrap="wrap">{`  ${(s.config as any).completion_summary}`}</Text>
          )}
        </>
      )}
      {s.status === "stopped" && (
        <Text color="gray">{`  ■ Session stopped by user`}</Text>
      )}
      {s.status === "failed" && !s.error && (
        <Text color="red">{`  ✕ Session failed`}</Text>
      )}
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

      {/* Token usage from hooks */}
      {(s.config as any)?.usage && (
        <KeyValue label="Tokens">
          {`${((s.config as any).usage.total_tokens / 1000).toFixed(1)}K (in:${((s.config as any).usage.input_tokens / 1000).toFixed(1)}K out:${((s.config as any).usage.output_tokens / 1000).toFixed(1)}K cache:${((s.config as any).usage.cache_read_input_tokens / 1000).toFixed(1)}K)`}
        </KeyValue>
      )}

      {/* Channel status */}
      {s.session_id && (s.status === "running" || s.status === "waiting") && (
        <Text color="green">
          {`  ⚡ Channel: port ${channelPort}`}
        </Text>
      )}

      {/* Conversation history or search results */}
      {searchMode && searchResults !== null ? (
        <>
          <Text> </Text>
          <SectionHeader title={`Search Results (${searchResults.length})`} />
          {searchResults.length === 0 && (
            <Text dimColor>{"  No matches found."}</Text>
          )}
          {searchResults.map((r, i) => (
            <Text key={i} wrap="wrap">
              {"  "}<Text dimColor>{r.timestamp?.slice(0, 16) ?? ""}</Text>
              <Text>{` ${r.match}`}</Text>
            </Text>
          ))}
        </>
      ) : conversation.length > 0 ? (
        <>
          <Text> </Text>
          <SectionHeader title="Conversation" />
          {conversation.map((turn, i) => {
            const label = turn.role === "user" ? "You" : turn.role === "assistant" ? "Claude" : turn.role;
            const color = turn.role === "user" ? "cyan" : undefined;
            const dim = turn.role !== "user";
            return (
              <Text key={i} wrap="wrap">
                {"  "}<Text color={color as any} dimColor={dim} bold>{label}:</Text>
                <Text color={color as any} dimColor={dim}>{` ${turn.content}`}</Text>
              </Text>
            );
          })}
        </>
      ) : null}

      {/* Agent output (live tmux capture) */}
      {agentOutput.trim() ? (
        <>
          <Text> </Text>
          <SectionHeader title="Live Output" />
          {agentOutput.split("\n").slice(-12).map((line, i) => (
            <Text key={i} wrap="truncate">{`  ${line}`}</Text>
          ))}
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
  const existing = useMemo(() => core.getGroups(), []);

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
            onSubmit={() => { if (newGroup.trim()) { onDone(newGroup.trim()); } }}
            placeholder="Enter group name..."
          />
        </Box>
        <Box flexGrow={1} />
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
      <Box flexGrow={1} />
    </Box>
  );
}

// ── Group Manager ──────────────────────────────────────────────────────────

interface GroupManagerProps {
  sessions: core.Session[];
  asyncState: AsyncState;
  onDone: (message?: string) => void;
}

function GroupManager({ sessions, asyncState, onDone }: GroupManagerProps) {
  const [action, setAction] = useState<"menu" | "create" | "delete">("menu");
  const [newName, setNewName] = useState("");
  const existing = useMemo(() => core.getGroups(), []);

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
              asyncState.run("Creating group...", () => {
                core.createGroup(newName.trim());
                onDone(`Group '${newName.trim()}' created`);
              });
            }}
            placeholder="Enter group name..."
          />
        </Box>
        <Box flexGrow={1} />
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
          <Box flexGrow={1} />
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
          onSelect={(item) => {
            asyncState.run("Deleting group...", async () => {
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
            });
          }}
        />
        <Box flexGrow={1} />
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
      <Box flexGrow={1} />
    </Box>
  );
}

// ── Talk to Session ────────────────────────────────────────────────────────

interface TalkToSessionProps {
  session: core.Session | null;
  asyncState: AsyncState;
  onDone: (message?: string) => void;
}

function TalkToSession({ session, asyncState, onDone }: TalkToSessionProps) {
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

  const channelPort = useMemo(() => session ? core.sessionChannelPort(session.id) : 0, [session?.id]);

  useInput((input, key) => {
    if (key.escape) onDone();
  });

  if (!session) {
    onDone();
    return null;
  }

  const send = () => {
    if (!msg.trim()) return;
    const text = msg.trim();
    setMsg("");
    asyncState.run("Sending message...", async () => {
      // Store outbound message
      core.addMessage({ session_id: session.id, role: "user", content: text });
      setMessages(core.getMessages(session.id, { limit: 20 }));
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
    });
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
            <Text key={m.id} wrap="wrap">
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
    </Box>
  );
}

// ── Clone Session ──────────────────────────────────────────────────────────

interface CloneSessionProps {
  session: core.Session | null;
  onDone: (name: string | null) => void;
}

function CloneSession({ session, onDone }: CloneSessionProps) {
  const [name, setName] = useState(session ? `${session.summary ?? session.id}-clone` : "");

  useInput((input, key) => {
    if (key.escape) onDone(null);
  });

  if (!session) { onDone(null); return null; }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color="cyan">{" Clone Session "}</Text>
      <Text> </Text>
      <Text dimColor>{`  Cloning: ${session.summary ?? session.id}`}</Text>
      <Text dimColor>{`  Repo: ${session.repo}`}</Text>
      <Text dimColor>{`  Claude conversation will be resumed`}</Text>
      <Text> </Text>
      <Text>{"  New session name:"}</Text>
      <Box>
        <Text color="cyan">{"> "}</Text>
        <TextInputEnhanced
          value={name}
          onChange={setName}
          onSubmit={() => { if (name.trim()) onDone(name.trim()); }}
          focus={true}
        />
      </Box>
      <Box flexGrow={1} />
    </Box>
  );
}

import React, { useState, useMemo, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";
import type { Session, Event, SearchResult } from "../../core/index.js";
import { ICON } from "../constants.js";
import { getStatusColor } from "../helpers/colors.js";
import type { InkColor } from "../helpers/colors.js";
import { hms } from "../helpers.js";
import { formatEvent } from "../helpers/formatEvent.js";
import { formatTokenDisplay, buildFileLinks, buildCommitLinks, stripAnsiAndFilter } from "../helpers/sessionFormatting.js";
import { getSessionCost, formatCost } from "../../core/costs.js";
import * as flow from "../../core/flow.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { Link } from "../components/Link.js";
import { KeyValue } from "../components/KeyValue.js";
import { TextInputEnhanced } from "../components/TextInputEnhanced.js";
import { useAgentOutput } from "../hooks/useAgentOutput.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useArkClient } from "../hooks/useArkClient.js";
import { matchesHotkey } from "../../core/hotkeys.js";

export interface SessionActions {
  dispatch: (id: string) => void;
  stop: (id: string) => void;
  restart: (id: string) => void;
  complete: (id: string) => void;
  interrupt: (id: string) => void;
  archive: (id: string) => void;
  restore: (id: string) => void;
}

export interface SessionDetailProps {
  session: Session | null;
  sessions: Session[];
  pane: "left" | "right";
  searchMode: boolean;
  searchQuery: string;
  searchResults: SearchResult[] | null;
  onSearchToggle: (on: boolean) => void;
  onSearchQueryChange: (q: string) => void;
  onSearchSubmit: (q: string) => void;
  /** Called when todos are mutated so parent can refresh if needed */
  onTodoChange?: () => void;
  /** Session lifecycle actions (dispatch, stop, restart, etc.) for right-pane shortcuts */
  actions?: SessionActions;
  /** Callback to open an overlay from the detail pane */
  onOverlay?: (overlay: string) => void;
}

export function SessionDetail({ session: s, sessions, pane, searchMode, searchQuery, searchResults, onSearchToggle, onSearchQueryChange, onSearchSubmit, onTodoChange, actions, onOverlay }: SessionDetailProps) {
  const theme = getTheme();
  const ark = useArkClient();
  const [events, setEvents] = useState<Event[]>([]);
  const [conversation, setConversation] = useState<{ role: string; content: string; timestamp: string }[]>([]);
  const [todos, setTodos] = useState<any[]>([]);
  const [todoSel, setTodoSel] = useState(0);
  const [todoAddMode, setTodoAddMode] = useState(false);
  const [todoAddText, setTodoAddText] = useState("");

  useEffect(() => {
    if (!s) { setEvents([]); return; }
    ark.sessionEvents(s.id, 50).then(setEvents).catch(() => setEvents([]));
  }, [s?.id, s?.status]);

  useEffect(() => {
    if (!s) { setTodos([]); return; }
    ark.todoList(s.id).then(r => setTodos(r.todos ?? [])).catch(() => setTodos([]));
  }, [s?.id, s?.status]);

  // Keep todoSel in bounds when todos change
  useEffect(() => {
    if (todoSel >= todos.length) setTodoSel(Math.max(0, todos.length - 1));
  }, [todos.length]);

  const refreshTodos = useCallback(() => {
    if (!s) return;
    ark.todoList(s.id).then(r => setTodos(r.todos ?? [])).catch(() => {});
    onTodoChange?.();
  }, [s?.id, onTodoChange]);

  // Todo CRUD input handler (right pane, not in search or todo-add mode)
  useInput((input, key) => {
    if (pane !== "right" || searchMode || !s) return;

    // Todo add mode: capture text input
    if (todoAddMode) return; // handled by TextInputEnhanced

    // 'A' to start adding a todo
    if (input === "A" && !key.ctrl && !key.meta) {
      setTodoAddMode(true);
      setTodoAddText("");
      return;
    }

    // Only operate on todos when we have some
    if (todos.length === 0) return;

    // Navigate todos with [ and ]
    if (input === "[") {
      setTodoSel(c => Math.max(0, c - 1));
      return;
    }
    if (input === "]") {
      setTodoSel(c => Math.min(todos.length - 1, c + 1));
      return;
    }

    // 'T' to toggle selected todo
    if (input === "T" && !key.ctrl && !key.meta) {
      const todo = todos[todoSel];
      if (todo) {
        ark.todoToggle(todo.id).then(() => refreshTodos()).catch(() => {});
      }
      return;
    }

    // 'D' to delete selected todo
    if (input === "D" && !key.ctrl && !key.meta) {
      const todo = todos[todoSel];
      if (todo) {
        ark.todoDelete(todo.id).then(() => refreshTodos()).catch(() => {});
      }
      return;
    }
  });

  // Session lifecycle actions in the right pane (dispatch, stop, restart, etc.)
  useInput((input, key) => {
    if (pane !== "right" || searchMode || todoAddMode || !s || !actions) return;

    if (key.return) {
      if (s.status === "ready" || s.status === "blocked") {
        actions.dispatch(s.id);
      } else if (["failed", "stopped", "completed"].includes(s.status)) {
        actions.restart(s.id);
      }
    } else if (matchesHotkey("stop", input, key)) {
      if (!["completed", "failed", "stopped"].includes(s.status)) {
        actions.stop(s.id);
      }
    } else if (matchesHotkey("interrupt", input, key)) {
      if (s.status === "running" || s.status === "waiting") {
        actions.interrupt(s.id);
      }
    } else if (matchesHotkey("complete", input, key)) {
      if (s.status === "running") {
        actions.complete(s.id);
      }
    } else if (matchesHotkey("talk", input, key)) {
      if ((s.status === "running" || s.status === "waiting") && onOverlay) {
        onOverlay("talk");
      }
    } else if (matchesHotkey("attach", input, key)) {
      // Delegate attach to parent via overlay callback (handled in SessionsTab)
      if (s.session_id && onOverlay) {
        onOverlay("attach");
      }
    } else if (matchesHotkey("archive", input, key)) {
      if (["completed", "stopped", "failed"].includes(s.status)) {
        actions.archive(s.id);
      } else if (s.status === "archived") {
        actions.restore(s.id);
      }
    } else if (matchesHotkey("worktreeFinish", input, key)) {
      if (s.workdir && onOverlay) {
        onOverlay("worktreeFinish");
      }
    } else if (matchesHotkey("verify", input, key)) {
      if (onOverlay) {
        onOverlay("verify");
      }
    }
  });

  // Load conversation history from Claude transcript (local sessions only)
  // Remote sessions don't have local transcripts — their conversation is in channel messages
  useEffect(() => {
    if (!s) { setConversation([]); return; }
    // Only load FTS5 conversation for sessions with a local claude_session_id
    // Remote sessions would match wrong transcripts (e.g. our own session mentioning the ID)
    if (!s.claude_session_id) { setConversation([]); return; }
    ark.sessionConversation(s.claude_session_id, 100).then(setConversation).catch(() => setConversation([]));
  }, [s?.id, s?.claude_session_id, s?.status]);

  // Channel port is deterministic: 19200 + (parseInt(id.replace("s-",""),16) % 10000)
  const channelPort = useMemo(() => {
    if (!s) return 0;
    return 19200 + (parseInt(s.id.replace("s-", ""), 16) % 10000);
  }, [s?.id]);
  const costInfo = useMemo(() => s ? getSessionCost(s) : null, [s?.id, s?.config]);

  // Sort search results by timestamp
  const sortedSearchResults = useMemo(() => {
    if (!searchResults) return null;
    return [...searchResults].sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
  }, [searchResults]);

  // Navigation for search results
  const { sel: searchSel } = useListNavigation(
    sortedSearchResults?.length ?? 0,
    { active: searchMode && pane === "right" && sortedSearchResults !== null && sortedSearchResults.length > 0 },
  );

  // Search mode: / to enter, Esc to exit
  // Todo add mode: Esc to cancel
  useInput((input, key) => {
    if (pane !== "right") return;
    if (todoAddMode) {
      if (key.escape) { setTodoAddMode(false); setTodoAddText(""); }
      return;
    }
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
    return (
      <Box flexDirection="column" flexGrow={1} paddingX={2} paddingTop={1}>
        {sessions.length === 0 ? (
          <>
            <Text bold color={theme.accent}>Welcome to Ark</Text>
            <Text> </Text>
            <Text>  <Text bold color={theme.accent}>n</Text>  Create your first session</Text>
            <Text>  <Text bold color={theme.accent}>?</Text>  See all keyboard shortcuts</Text>
            <Text>  <Text bold color={theme.accent}>q</Text>  Quit</Text>
            <Text> </Text>
            <Text dimColor>Or from the terminal:</Text>
            <Text dimColor>  ark session start --repo . --summary "Fix a bug" --dispatch</Text>
          </>
        ) : (
          <Text dimColor>Select a session from the list.</Text>
        )}
      </Box>
    );
  }

  return (
    <DetailPanel active={pane === "right"}>
      {/* Search bar */}
      {searchMode && (
        <Box marginBottom={1}>
          <Text color={theme.accent}>{" / "}</Text>
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
        <Text color={getStatusColor(s.status)} bold>
          {`${ICON[s.status] ?? "?"} ${s.error ? s.error : s.status}`}
        </Text>
      </KeyValue>
      {s.status === "completed" && (
        <>
          <Text color="green" bold>{`  ✓ Agent completed successfully`}</Text>
          {s.config?.completion_summary && (
            <Text color="green" wrap="wrap">{`  ${s.config.completion_summary}`}</Text>
          )}
        </>
      )}
      {s.status === "stopped" && (
        <Text color="gray">{`  ■ Session stopped by user`}</Text>
      )}
      {s.status === "failed" && !s.error && (
        <Text color="red">{`  ✕ Session failed`}</Text>
      )}
      {s.status === "waiting" && s.breakpoint_reason && (
        <Text color="yellow" bold wrap="wrap">{`  ⏸ ${s.breakpoint_reason}`}</Text>
      )}
      <KeyValue label="Compute">{s.compute_name || "local"}</KeyValue>
      {s.repo && <KeyValue label="Repo">{s.repo}</KeyValue>}
      {s.branch && <KeyValue label="Branch">{s.branch}</KeyValue>}
      {s.workdir && s.workdir !== s.repo && (
        <KeyValue label="Workdir">{s.workdir}</KeyValue>
      )}
      {s.config?.remoteWorkdir && (
        <KeyValue label="Remote">{String(s.config.remoteWorkdir)}</KeyValue>
      )}
      <KeyValue label="Flow">{s.flow}</KeyValue>
      {s.stage && <KeyValue label="Stage">{s.stage}</KeyValue>}
      {s.agent && <KeyValue label="Agent">{s.agent}</KeyValue>}
      {s.group_name && <KeyValue label="Group">{s.group_name}</KeyValue>}

      {/* Flow pipeline */}
      {s.flow && s.stage && (() => {
        const stages = flow.getStages(s.flow);
        if (stages.length <= 1) return null;
        return (
          <Box>
            <Text dimColor>{"  "}</Text>
            {stages.map((st, idx) => {
              const isCurrent = st.name === s.stage;
              const isPast = stages.findIndex(x => x.name === s.stage) > idx;
              return (
                <React.Fragment key={st.name}>
                  {idx > 0 && <Text dimColor>{" > "}</Text>}
                  <Text color={isCurrent ? theme.accent : isPast ? "green" : undefined} bold={isCurrent} dimColor={!isCurrent && !isPast}>
                    {isCurrent ? `[${st.name}]` : st.name}
                  </Text>
                </React.Fragment>
              );
            })}
          </Box>
        );
      })()}

      {s.pr_url && (
        <KeyValue label="PR">
          <Link url={s.pr_url} color={theme.accent}>{s.pr_url.replace("https://github.com/", "")}</Link>
        </KeyValue>
      )}

      {/* Token usage */}
      {formatTokenDisplay(s) && (
        <KeyValue label="Tokens">{formatTokenDisplay(s)}</KeyValue>
      )}
      {costInfo && costInfo.cost > 0 && (
        <KeyValue label="Cost">{formatCost(costInfo.cost)}</KeyValue>
      )}

      {/* Todos */}
      {todos.length > 0 ? (
        <>
          <Text> </Text>
          <SectionHeader title={`Todos (${todos.filter((t: any) => t.done).length}/${todos.length})`} />
          {todos.map((t: any, idx: number) => {
            const isSel = pane === "right" && idx === todoSel;
            return (
              <Text key={t.id} wrap="wrap" inverse={isSel}>
                {"  "}<Text color={t.done ? "green" : "yellow"}>{t.done ? "+" : "o"}</Text>
                <Text dimColor={t.done}>{` ${t.content}`}</Text>
              </Text>
            );
          })}
          {todoAddMode && (
            <Box>
              <Text color={theme.accent}>{"  + "}</Text>
              <TextInputEnhanced
                value={todoAddText}
                onChange={setTodoAddText}
                onSubmit={(val: string) => {
                  setTodoAddMode(false);
                  if (val.trim() && s) {
                    ark.todoAdd(s.id, val.trim()).then(() => refreshTodos()).catch(() => {});
                  }
                }}
                focus={todoAddMode}
                placeholder="New todo..."
              />
            </Box>
          )}
          {pane === "right" && !todoAddMode && (
            <Text dimColor>{"  A:add  T:toggle  D:delete  [/]:navigate"}</Text>
          )}
        </>
      ) : (
        <>
          <Text> </Text>
          <SectionHeader title="Todos" />
          {todoAddMode ? (
            <Box>
              <Text color={theme.accent}>{"  + "}</Text>
              <TextInputEnhanced
                value={todoAddText}
                onChange={setTodoAddText}
                onSubmit={(val: string) => {
                  setTodoAddMode(false);
                  if (val.trim() && s) {
                    ark.todoAdd(s.id, val.trim()).then(() => refreshTodos()).catch(() => {});
                  }
                }}
                focus={todoAddMode}
                placeholder="New todo..."
              />
            </Box>
          ) : (
            <Text dimColor>{pane === "right" ? "  No todos. Press A to add." : "  No todos."}</Text>
          )}
        </>
      )}

      {/* Files changed - as a collapsible list */}
      {buildFileLinks(s) && (() => {
        const fileLinks = buildFileLinks(s)!;
        return (
          <>
            <Text> </Text>
            <Text bold dimColor>{`  Files changed (${fileLinks.length})`}</Text>
            {fileLinks.slice(0, 15).map((f) => (
              <Text key={f.path} dimColor>
                {f.url
                  ? `    \x1b]8;;${f.url}\x07${f.path}\x1b]8;;\x07`
                  : `    ${f.path}`}
              </Text>
            ))}
            {fileLinks.length > 15 && <Text dimColor>{`    ... and ${fileLinks.length - 15} more`}</Text>}
          </>
        );
      })()}

      {/* Commits - with GitHub links */}
      {buildCommitLinks(s) && (() => {
        const commitLinks = buildCommitLinks(s)!;
        return (
          <>
            <Text> </Text>
            <Text bold dimColor>{`  Commits (${commitLinks.length})`}</Text>
            {commitLinks.slice(0, 10).map((c) => (
              <Text key={c.shortSha} dimColor>
                {c.url
                  ? `    \x1b]8;;${c.url}\x07${c.shortSha}\x1b]8;;\x07`
                  : `    ${c.shortSha}`}
              </Text>
            ))}
          </>
        );
      })()}

      {/* Channel status */}
      {s.session_id && (s.status === "running" || s.status === "waiting") && (
        <Text color="green">
          {`  ⚡ Channel: port ${channelPort}`}
        </Text>
      )}

      {/* Conversation history or search results */}
      {searchMode && sortedSearchResults !== null ? (
        <>
          <Text> </Text>
          <SectionHeader title={`Search Results (${sortedSearchResults.length})`} />
          {sortedSearchResults.length === 0 && (
            <Text dimColor>{"  No matches found."}</Text>
          )}
          {sortedSearchResults.map((r, idx) => (
            <Text key={`${r.source}-${r.timestamp ?? idx}`} wrap="wrap" inverse={idx === searchSel}>
              {"  "}<Text dimColor>{r.sessionId?.slice(0, 8) ?? ""} </Text>
              <Text dimColor>{r.timestamp?.slice(0, 16) ?? ""}</Text>
              <Text>{` ${r.match}`}</Text>
            </Text>
          ))}
        </>
      ) : conversation.length > 0 ? (
        <>
          <Text> </Text>
          <SectionHeader title="Conversation" />
          {conversation.map((turn, idx) => {
            const label = turn.role === "user" ? "You" : turn.role === "assistant" ? "Claude" : turn.role;
            const color: InkColor | undefined = turn.role === "user" ? theme.accent : undefined;
            const dim = turn.role !== "user";
            return (
              <Text key={`${turn.role}-${turn.timestamp}-${idx}`} wrap="wrap">
                {"  "}<Text color={color} dimColor={dim} bold>{label}:</Text>
                <Text color={color} dimColor={dim}>{` ${turn.content}`}</Text>
              </Text>
            );
          })}
        </>
      ) : (s.status === "running") ? (
        <>
          <Text> </Text>
          <SectionHeader title="Conversation" />
          <Text dimColor>{"  Waiting for agent output..."}</Text>
        </>
      ) : null}

      {/* Agent output (live tmux capture) */}
      {agentOutput.trim() ? (
        <>
          <Text> </Text>
          <SectionHeader title="Live Output" />
          {stripAnsiAndFilter(agentOutput).map((line, idx) => (
            <Text key={`out-${idx}`} wrap="truncate">{`  ${line}`}</Text>
          ))}
        </>
      ) : (s.status === "running") ? (
        <>
          <Text> </Text>
          <SectionHeader title="Live Output" />
          <Text dimColor>{"  Agent starting up..."}</Text>
        </>
      ) : null}

      {/* Events - visual separator */}
      <>
        <Text> </Text>
        <SectionHeader title="Events" />
        {events.length > 0 ? (
          events.slice(-10).map((ev) => {
            const ts = hms(ev.created_at).slice(0, 5); // HH:MM
            const msg = formatEvent(ev.type, ev.data ?? undefined);
            return (
              <Text key={ev.id}>
                {"  "}<Text dimColor>{ts}</Text>{"  "}
                {msg}
              </Text>
            );
          })
        ) : (
          <Text dimColor>{"  No events yet"}</Text>
        )}
      </>
    </DetailPanel>
  );
}

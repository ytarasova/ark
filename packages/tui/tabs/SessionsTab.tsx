import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";
import type { Session, SearchResult } from "../../core/index.js";
import { ICON } from "../constants.js";
import { getStatusColor } from "../helpers/colors.js";
import { fitText, sessionLabel } from "../helpers/sessionFormatting.js";
import { ago } from "../helpers.js";
import { KeyHint, sep } from "../helpers/statusBarHints.js";
import { SplitPane } from "../components/SplitPane.js";
import { TreeList } from "../components/TreeList.js";
import { ThreadsPanel } from "../components/ThreadsPanel.js";
import { useSessionActions } from "../hooks/useSessionActions.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import { useConfirmation } from "../hooks/useConfirmation.js";
import { useAuthStatus } from "../hooks/useAuthStatus.js";
import { useGroupActions } from "../hooks/useGroupActions.js";
import { useFocus } from "../hooks/useFocus.js";
import { useArkClient } from "../hooks/useArkClient.js";
import { SessionDetail } from "./SessionDetail.js";
import { MoveToGroup } from "./MoveToGroup.js";
import { GroupManager } from "./GroupManager.js";
import { TalkToSession } from "./TalkToSession.js";
import { CloneSession } from "./CloneSession.js";
import { SessionReplay } from "./SessionReplay.js";
import { McpManager } from "../components/McpManager.js";
import { SkillsManager } from "../components/SkillsManager.js";
import { SettingsPanel } from "../components/SettingsPanel.js";
import { SessionSearch } from "../components/SessionSearch.js";
import { MemoryManager } from "../components/MemoryManager.js";
import type { StoreData } from "../hooks/useArkStore.js";
import type { AsyncState } from "../hooks/useAsync.js";
import { matchesHotkey } from "../../core/hotkeys.js";

type Overlay = "move" | "group" | "talk" | "inbox" | "fork" | "search" | "replay" | "mcp" | "skills" | "settings" | "find" | "memory" | "worktreeFinish" | null;

/**
 * State that contributes to "which sessions are visible" in the left pane.
 * Today this is the status filter and group-by mode; kept as a struct so
 * future filter dimensions can join here without rewriting callers.
 */
export interface SessionListFilters {
  statusFilter: string | null;
  groupByStatus: boolean;
}

/** Initial empty filter state (no filters applied -- all sessions visible). */
export const EMPTY_SESSION_FILTERS: SessionListFilters = { statusFilter: null, groupByStatus: false };

/** True if any list filter dimension is currently active. */
export function hasActiveSessionFilters(f: SessionListFilters): boolean {
  return f.statusFilter !== null;
}

/** Reset every list filter dimension to its empty default. Pure helper. */
export function resetSessionFilters(_current: SessionListFilters): SessionListFilters {
  return EMPTY_SESSION_FILTERS;
}

/** Map a session status to a display group label for status grouping. */
export function statusGroupLabel(status: string): string {
  switch (status) {
    case "running": return "Running";
    case "waiting": return "Waiting";
    case "blocked": return "Blocked";
    case "ready": return "Ready";
    case "pending": return "Pending";
    case "completed": return "Completed";
    case "stopped": return "Stopped";
    case "failed": return "Failed";
    case "archived": return "Archived";
    default: return "Other";
  }
}

/** Ordering for status group headers (lower = higher in list). */
const STATUS_GROUP_ORDER: Record<string, number> = {
  Running: 0,
  Waiting: 1,
  Blocked: 2,
  Ready: 3,
  Pending: 4,
  Completed: 5,
  Stopped: 6,
  Failed: 7,
  Archived: 8,
  Other: 9,
};

interface SessionsTabProps extends StoreData {
  asyncState: AsyncState;
  pane: "left" | "right";
  onShowForm: () => void;
  onSelectionChange?: (session: Session | null) => void;
  onFiltersChange?: (filters: SessionListFilters) => void;
  formOverlay?: React.ReactNode;
  refresh: () => void;
}

export function SessionsTab({ sessions, refresh, pane, unreadCounts, asyncState, onShowForm, onSelectionChange, onFiltersChange, formOverlay }: SessionsTabProps) {
  const theme = getTheme();
  const ark = useArkClient();
  const focus = useFocus();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const confirmation = useConfirmation();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [groupByStatus, setGroupByStatus] = useState(false);
  const status = useStatusMessage();

  // Notify parent when filter state changes so the status bar can show the
  // "Esc:clear filter" hint while any filter is active.
  useEffect(() => {
    onFiltersChange?.({ statusFilter, groupByStatus });
  }, [statusFilter, groupByStatus, onFiltersChange]);

  // Reset filters (not view modes like groupByStatus). Wired to Esc on the left pane.
  const clearAllFilters = useCallback(() => {
    setStatusFilter(null);
  }, []);

  // Top-level sessions (no pre-sort needed -- TreeList handles ordering via groupBy/groupSort)
  const topLevel = useMemo(() => sessions.filter((s) => !s.parent_id), [sessions]);

  const filteredTopLevel = useMemo(() => {
    if (!statusFilter) return topLevel;
    return topLevel.filter(s => {
      if (statusFilter === "running") return s.status === "running";
      if (statusFilter === "waiting") return ["waiting", "blocked"].includes(s.status);
      if (statusFilter === "stopped") return ["stopped", "completed", "pending"].includes(s.status);
      if (statusFilter === "failed") return ["failed"].includes(s.status);
      return true;
    });
  }, [topLevel, statusFilter]);

  const hasOverlay = formOverlay || overlay;
  const [selected, setSelected] = useState<Session | null>(null);

  /** Move selection to the next (or previous) item after a removal. */
  const selectNextAfterRemoval = (removedId: string) => {
    const idx = filteredTopLevel.findIndex(s => s.id === removedId);
    const next = filteredTopLevel[idx + 1] ?? filteredTopLevel[idx - 1] ?? null;
    setSelected(next);
  };

  // Push/pop focus when overlay opens/closes
  const prevOverlayRef = useRef<Overlay>(null);
  useEffect(() => {
    if (overlay) {
      focus.push(overlay);
    } else if (prevOverlayRef.current) {
      focus.pop(prevOverlayRef.current);
    }
    prevOverlayRef.current = overlay;
  }, [overlay]);

  // Clear search state when selected session changes
  useEffect(() => { setSearchResults(null); setSearchQuery(""); }, [selected?.id]);

  // Notify parent of selection changes for status bar
  useEffect(() => {
    onSelectionChange?.(selected);
  }, [selected?.id, selected?.status, onSelectionChange]);

  // Helper: get all sessions in the same group as selected
  const selectedGroup = selected?.group_name ?? "";
  const groupSessions = useMemo(
    () => filteredTopLevel.filter(s => (s.group_name ?? "") === selectedGroup),
    [filteredTopLevel, selectedGroup],
  );

  // Memoize group list -- depends on sessions (groups derived from session group_names + groups table)
  const [groups, setGroups] = useState<any[]>([]);
  useEffect(() => { ark.groupList().then(setGroups); }, [sessions.length]);

  // Memoize groupBy and groupSort callbacks so TreeList's useMemo doesn't
  // recalculate on every render when groupByStatus hasn't changed.
  const groupByFn = useMemo(
    () => groupByStatus ? (s: Session) => statusGroupLabel(s.status) : (s: Session) => s.group_name ?? "",
    [groupByStatus],
  );
  const groupSortFn = useMemo(
    () => groupByStatus ? ((a: string, b: string) => (STATUS_GROUP_ORDER[a] ?? 9) - (STATUS_GROUP_ORDER[b] ?? 9)) : undefined,
    [groupByStatus],
  );

  const actions = useSessionActions(asyncState, status.show);
  const _groupActions = useGroupActions(asyncState);

  // Extracted attach helper -- shared between left-pane useInput and right-pane overlay callback
  const doAttach = useCallback((session: Session) => {
    if (!session.session_id) return;
    const sid = session.session_id;
    asyncState.run("Attaching...", async () => {
      const compute = session.compute_name ? await ark.computeRead(session.compute_name).catch(() => null) : null;
      const attachCompute = compute ?? await ark.computeRead("local");
      const { getProvider } = await import("../../compute/index.js");
      const provider = getProvider(attachCompute.provider);
      if (!provider) { status.show("Provider not found"); return; }

      const exists = await provider.checkSession(attachCompute, sid);
      if (!exists) {
        status.show(`Session not found on ${attachCompute.name}`);
        return;
      }

      const attachCmd = provider.getAttachCommand(attachCompute, session);
      if (attachCmd.length === 0) { status.show("Cannot attach to this session"); return; }

      // Attach: mute Ink, reset terminal for tmux, spawn+wait, restore Ink
      const origWrite = process.stdout.write.bind(process.stdout);
      const origErrWrite = process.stderr.write.bind(process.stderr);
      process.stdout.write = (() => true) as typeof process.stdout.write;
      process.stderr.write = (() => true) as typeof process.stderr.write;
      setTimeout(() => {
        process.stdout.write = origWrite;
        process.stderr.write = origErrWrite;
        // Reset terminal state so tmux gets a clean terminal
        try { process.stdin.setRawMode(false); } catch { /* stdin may not be a TTY */ }
        process.stdout.write("\x1b[?1049l"); // exit alt screen if active
        process.stdout.write("\x1b[?25h");    // show cursor
        // Spawn attach command -- local tmux or SSH+tmux for remote
        Bun.spawnSync(attachCmd, {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          env: { ...process.env, TERM: "xterm-256color" },
        });
        // Restore terminal for Ink
        try { process.stdin.setRawMode(true); } catch { /* stdin may not be a TTY */ }
        process.stdout.write("\x1b[?25l");      // hide cursor
        process.stdout.write("\x1b[2J\x1b[H");  // clear screen
        status.show("Detached from session");
      }, 100);
    });
  }, [ark, asyncState, status]);

  // Auth status for selected session's compute target
  const [selectedCompute, setSelectedCompute] = useState<any>(null);
  useEffect(() => {
    if (selected?.compute_name) {
      ark.computeRead(selected.compute_name).then(setSelectedCompute).catch(() => setSelectedCompute(null));
    } else {
      setSelectedCompute(null);
    }
  }, [selected?.compute_name]);
  const authStatus = useAuthStatus(selectedCompute);

  useInput((input, key) => {
    if (pane !== "left" || hasOverlay) return;

    // Esc clears every active filter dimension at once. No-op if nothing is
    // filtered, so Esc never feels broken regardless of state.
    if (key.escape) {
      if (confirmation.pending) { confirmation.cancel(); status.clear(); return; }
      if (hasActiveSessionFilters({ statusFilter, groupByStatus })) {
        clearAllFilters();
        status.show("Filters cleared");
      }
      return;
    }

    // Global keys — work regardless of selection
    if (matchesHotkey("search", input, key)) { setOverlay("find"); return; }
    if (matchesHotkey("newSession", input, key)) { onShowForm(); return; }
    if (matchesHotkey("inbox", input, key)) { setOverlay("inbox"); return; }
    if (matchesHotkey("group", input, key)) { setOverlay("group"); return; }

    // Ctrl+Z: undo last delete
    if (matchesHotkey("undo", input, key)) {
      if (actions.undoDelete()) {
        status.show("Session restored");
      }
      return;
    }

    // Status filter shortcuts
    if (matchesHotkey("filterRunning", input, key)) {
      setStatusFilter(f => f === "running" ? null : "running");
      return;
    }
    if (matchesHotkey("filterWaiting", input, key)) {
      setStatusFilter(f => f === "waiting" ? null : "waiting");
      return;
    }
    if (matchesHotkey("filterStopped", input, key)) {
      setStatusFilter(f => f === "stopped" ? null : "stopped");
      return;
    }
    if (matchesHotkey("filterFailed", input, key)) {
      setStatusFilter(f => f === "failed" ? null : "failed");
      return;
    }
    if (matchesHotkey("filterClear", input, key)) {
      setStatusFilter(null);
      return;
    }
    if (matchesHotkey("groupByStatus", input, key)) {
      setGroupByStatus(v => !v);
      setSelected(null); // Reset to top of new group order
      return;
    }

    // Settings (no selection needed)
    if (matchesHotkey("settings", input, key)) { setOverlay("settings"); return; }

    // Memory manager (no selection needed)
    if (matchesHotkey("memory", input, key)) { setOverlay("memory"); return; }

    // Cancel pending confirms on unrelated keys
    if (confirmation.pending && !matchesHotkey("complete", input, key) && !matchesHotkey("delete", input, key)) {
      confirmation.cancel();
      status.clear();
    }

    // Everything below requires a selected session
    if (!selected) return;

    // Skills manager
    if (matchesHotkey("skills", input, key)) { setOverlay("skills"); return; }

    // Clone session (C)
    if (matchesHotkey("clone", input, key)) {
      if (selected) setOverlay("fork");
      return;
    }

    // Mark as waiting (unread)
    if (matchesHotkey("markUnread", input, key)) {
      asyncState.run("Marking as waiting...", async () => {
        await ark.sessionUpdate(selected.id, { status: "waiting" });
        status.show("Marked as waiting");
        refresh();
      });
      return;
    }

    if (key.return) {
      if (selected.status === "ready" || selected.status === "blocked") {
        if (!authStatus.hasAuth) {
          status.show("Run 'ark auth' in another terminal first");
          return;
        }
        actions.dispatch(selected.id);
      } else if (["failed", "stopped", "completed"].includes(selected.status)) {
        actions.restart(selected.id);
      }
    } else if (matchesHotkey("stop", input, key)) {
      if (!["completed", "failed", "stopped"].includes(selected.status)) {
        actions.stop(selected.id);
      }
    } else if (matchesHotkey("restart", input, key)) {
      if (["completed", "stopped", "failed"].includes(selected.status)) {
        setOverlay("replay");
      } else if (selected.status === "blocked") {
        actions.restart(selected.id);
      }
    } else if (matchesHotkey("fork", input, key)) {
      // Fork: deep copy with conversation continuity (opens name prompt)
      if (selected) setOverlay("fork");
    } else if (matchesHotkey("delete", input, key)) {
      if (confirmation.confirm("delete", `Delete '${selected.summary ?? selected.id}'? Press x again to confirm`)) {
        selectNextAfterRemoval(selected.id);
        actions.delete(selected.id);
        status.show("Deleted. Ctrl+Z to undo (90s)");
      }
    } else if (matchesHotkey("attach", input, key)) {
      if (selected) doAttach(selected);
    } else if (matchesHotkey("move", input, key)) {
      if (selected) setOverlay("move");
    } else if (matchesHotkey("mcp", input, key)) {
      if (selected?.workdir) setOverlay("mcp");
    } else if (matchesHotkey("complete", input, key)) {
      if (selected && selected.status === "running") {
        if (confirmation.confirm("complete", `Done with '${selected.summary ?? selected.id}'? Press d again to confirm`)) {
          actions.complete(selected.id);
        }
      }
    } else if (matchesHotkey("talk", input, key)) {
      if (selected?.status === "running" || selected?.status === "waiting") setOverlay("talk");
    } else if (matchesHotkey("advance", input, key)) {
      if (selected && ["running", "waiting", "blocked"].includes(selected.status)) {
        asyncState.run("Advancing...", async () => {
          const result = await ark.sessionAdvance(selected.id, true);
          status.show(result.ok ? "Advanced to next stage" : result.message);
          refresh();
        });
      }
    } else if (matchesHotkey("worktreeFinish", input, key)) {
      if (selected && selected.workdir) {
        setOverlay("worktreeFinish");
      }
    } else if (matchesHotkey("interrupt", input, key)) {
      if (selected && (selected.status === "running" || selected.status === "waiting")) {
        actions.interrupt(selected.id);
      }
    } else if (matchesHotkey("verify", input, key)) {
      if (selected) {
        asyncState.run("Verifying...", async () => {
          const result = await ark.verifyRun(selected.id);
          if (result.ok) {
            status.show("Verification passed");
          } else {
            status.show(`Verification failed: ${result.message?.slice(0, 80)}`);
          }
          refresh();
        });
      }
    } else if (matchesHotkey("archive", input, key)) {
      if (selected && ["completed", "stopped", "failed"].includes(selected.status)) {
        selectNextAfterRemoval(selected.id);
        actions.archive(selected.id);
      } else if (selected?.status === "archived") {
        actions.restore(selected.id);
      }
    } else if (matchesHotkey("export", input, key)) {
      if (selected) {
        const outPath = `session-${selected.id}.json`;
        asyncState.run(`Exporting ${selected.id}...`, async () => {
          const result = await ark.sessionExport(selected.id, outPath);
          if (result.ok) {
            status.show(`Exported to ${result.filePath ?? outPath}`);
          } else {
            status.show("Export failed");
          }
          refresh();
        });
      }
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
        setSelected(null);
      }
    }
  });

  // Worktree finish overlay: M = merge locally, P = create PR, Esc = cancel
  useInput((input, key) => {
    if (overlay !== "worktreeFinish" || !selected) return;
    if (key.escape) { setOverlay(null); return; }
    if (input === "m" || input === "M") {
      setOverlay(null);
      asyncState.run("Finishing worktree...", async () => {
        const result = await ark.worktreeFinish(selected.id, { noMerge: false });
        status.show(result.ok ? result.message : `Worktree: ${result.message}`);
        refresh();
      });
    } else if (input === "p" || input === "P") {
      setOverlay(null);
      actions.createPR(selected.id, selected.summary ?? undefined);
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <SplitPane
        focus={overlay === "talk" || overlay === "inbox" ? "right" : pane}
        outerChrome={7}
        leftTitle={statusFilter && groupByStatus ? `Sessions [${statusFilter}, by status]` : statusFilter ? `Sessions [${statusFilter}]` : groupByStatus ? "Sessions [by status]" : "Sessions"}
        rightTitle="Details"
        left={
          <TreeList
            items={filteredTopLevel}
            getKey={(s) => s.id}
            groupBy={groupByFn}
            emptyGroups={groupByStatus ? undefined : groups}
            groupSort={groupSortFn}
            renderRow={(s) => {
              // Must match renderColoredRow width exactly
              const cols = Math.floor((process.stdout.columns ?? 120) * 0.3) - 4;
              const icon = ICON[s.status] ?? "?";
              const age = ago(s.updated_at ?? s.created_at);
              const unread = unreadCounts.get(s.id) ?? 0;
              const badge = unread > 0 ? ` (${unread})` : "";
              const reserved = 5 + age.length + badge.length;
              const summaryWidth = Math.max(cols - reserved, 8);
              const summary = fitText(sessionLabel(s), summaryWidth);
              return `${icon} ${summary} ${age}${badge}`;
            }}
            renderColoredRow={(s) => {
              // SplitPane left is 30% width minus border+padding (~4 chars)
              const cols = Math.floor((process.stdout.columns ?? 120) * 0.3) - 4;
              const icon = ICON[s.status] ?? "?";
              const color = getStatusColor(s.status);
              const age = ago(s.updated_at ?? s.created_at);
              const unread = unreadCounts.get(s.id) ?? 0;
              const badge = unread > 0 ? ` (${unread})` : "";
              // Reserve: 2 indent + 2 icon+space + age + badge
              const reserved = 5 + age.length + badge.length;
              const summaryWidth = Math.max(cols - reserved, 8);
              const summary = fitText(sessionLabel(s), summaryWidth);
              return (
                <Text>
                  {"  "}<Text color={color}>{icon}</Text>{` ${summary}`}
                  <Text dimColor>{` ${age}`}</Text>
                  {unread > 0 && <Text color={theme.waiting} bold>{badge}</Text>}
                </Text>
              );
            }}
            renderChildren={(s) => {
              const children = sessions.filter(c => c.parent_id === s.id);
              if (children.length === 0) return null;
              return children.map(child => {
                const childIcon = ICON[child.status] ?? "?";
                const childColor = getStatusColor(child.status);
                const childLabel = (child.summary ?? "(fork)").slice(0, 24);
                const childAge = ago(child.updated_at ?? child.created_at).padStart(4);
                return (
                  <Text key={child.id} dimColor>
                    {"    \u2514 "}<Text color={childColor}>{childIcon}</Text>{` ${childLabel}`}
                    <Text>{`  ${childAge}`}</Text>
                  </Text>
                );
              });
            }}
            selectedKey={selected?.id ?? null}
            onSelect={(item) => setSelected(item)}
            active={pane === "left" && !hasOverlay}
            emptyMessage={statusFilter ? `No ${statusFilter} sessions.` : "No sessions."}
          />
        }
        right={
          formOverlay ? formOverlay
          : overlay === "fork" ? (
            <CloneSession
              session={selected}
              onDone={(name) => {
                setOverlay(null);
                if (!selected || !name) return;
                actions.fork(selected.id, name, selected.group_name);
              }}
            />
          )
          : overlay === "inbox" ? (
            <ThreadsPanel
              sessions={topLevel}
              onDone={() => { setOverlay(null); refresh(); }}
            />
          )
          : overlay === "talk" ? (
            <TalkToSession
              session={selected}
              asyncState={asyncState}
              onDone={(msg) => {
                if (msg) status.show(msg);
                setOverlay(null);
              }}
            />
          )
          : overlay === "group" ? (
            <GroupManager
              sessions={topLevel}
              asyncState={asyncState}
              onDone={(msg) => {
                if (msg) { status.show(msg); refresh(); }
                setOverlay(null);
              }}
            />
          )
          : overlay === "move" ? (
            <MoveToGroup
              session={selected}
              onDone={(group) => {
                if (selected && group !== undefined) {
                  asyncState.run("Moving session...", async () => {
                    await ark.sessionUpdate(selected.id, { group_name: group || null });
                    status.show(group ? `Moved to '${group}'` : "Removed from group");
                    refresh();
                  });
                }
                setOverlay(null);
              }}
            />
          )
          : overlay === "mcp" && selected ? (
            <McpManager
              session={selected}
              onClose={() => setOverlay(null)}
              onApply={() => { refresh(); }}
            />
          )
          : overlay === "replay" && selected ? (
            <SessionReplay
              session={selected}
              onClose={() => setOverlay(null)}
            />
          )
          : overlay === "skills" && selected ? (
            <SkillsManager
              session={selected}
              asyncState={asyncState}
              onClose={() => { setOverlay(null); refresh(); }}
            />
          )
          : overlay === "settings" ? (
            <SettingsPanel
              onClose={() => setOverlay(null)}
            />
          )
          : overlay === "memory" ? (
            <MemoryManager
              asyncState={asyncState}
              onClose={() => setOverlay(null)}
            />
          )
          : overlay === "find" ? (
            <SessionSearch
              sessions={topLevel}
              onSelect={(s) => {
                setSelected(s);
              }}
              onClose={() => setOverlay(null)}
            />
          )
          : overlay === "worktreeFinish" ? (
            <Box flexDirection="column" padding={1}>
              <Text bold>Finish Worktree</Text>
              <Text> </Text>
              <Text>  <Text color={theme.accent} bold>M</Text> Merge locally</Text>
              <Text>  <Text color={theme.accent} bold>P</Text> Create PR on GitHub</Text>
              <Text> </Text>
              <Text dimColor>  Esc to cancel</Text>
            </Box>
          )
          : <SessionDetail
              session={selected}
              sessions={sessions}
              pane={pane}
              searchMode={overlay === "search"}
              searchQuery={searchQuery}
              searchResults={searchResults}
              onSearchToggle={(on) => {
                setOverlay(on ? "search" : null);
                if (!on) { setSearchQuery(""); setSearchResults(null); }
              }}
              onSearchQueryChange={setSearchQuery}
              onSearchSubmit={(q) => {
                if (!selected || !q.trim()) return;
                const convId = selected.claude_session_id || selected.id;
                ark.sessionSearchConversation(convId, q.trim()).then(setSearchResults);
              }}
              actions={{
                dispatch: actions.dispatch,
                stop: actions.stop,
                restart: actions.restart,
                complete: actions.complete,
                interrupt: actions.interrupt,
                archive: actions.archive,
                restore: actions.restore,
              }}
              onOverlay={(name) => {
                if (name === "attach" && selected) {
                  doAttach(selected);
                } else if (name === "verify" && selected) {
                  asyncState.run("Verifying...", async () => {
                    const result = await ark.verifyRun(selected.id);
                    if (result.ok) {
                      status.show("Verification passed");
                    } else {
                      status.show(`Verification failed: ${result.message?.slice(0, 80)}`);
                    }
                    refresh();
                  });
                } else if (name === "talk" || name === "worktreeFinish") {
                  setOverlay(name as Overlay);
                }
              }}
            />
        }
      />
      <Box height={1}>
        {(status.message || confirmation.status.message) ? (
          <Text color={confirmation.pending === "delete" ? "red" : theme.accent}>
            {` ${confirmation.status.message ?? status.message}`}
          </Text>
        ) : <Text>{" "}</Text>}
      </Box>
    </Box>
  );
}

export function getSessionHints(
  s: Session | null | undefined,
  filters: SessionListFilters = EMPTY_SESSION_FILTERS,
): React.ReactNode[] {
  const hints: React.ReactNode[] = [];

  // Show "Esc:clear filter" first whenever ANY list filter is active so the
  // user always has an obvious escape hatch from a stuck filter state.
  if (hasActiveSessionFilters(filters)) {
    hints.push(<KeyHint key="escClear" k="Esc" label="clear filter" />);
    hints.push(sep(0));
  }

  // Show group-by-status toggle hint
  hints.push(<KeyHint key="grp" k="%" label={filters.groupByStatus ? "ungroup" : "group"} />);

  if (s) {
    // Status-specific actions
    switch (s.status) {
      case "ready":
      case "blocked":
        hints.push(<KeyHint key="enter" k="Enter" label="dispatch" />);
        hints.push(<KeyHint key="A3" k="A" label="advance" />);
        break;
      case "running":
        hints.push(<KeyHint key="a" k="a" label="attach" />);
        hints.push(<KeyHint key="t" k="t" label="chat" />);
        hints.push(<KeyHint key="s" k="s" label="stop" />);
        hints.push(<KeyHint key="I" k="I" label="interrupt" />);
        break;
      case "stopped":
      case "failed":
      case "completed":
        hints.push(<KeyHint key="enter" k="Enter" label="restart" />);
        hints.push(<KeyHint key="r" k="r" label="replay" />);
        hints.push(<KeyHint key="Z" k="Z" label="archive" />);
        break;
      case "archived":
        hints.push(<KeyHint key="Z" k="Z" label="restore" />);
        break;
      case "waiting":
        hints.push(<KeyHint key="a" k="a" label="attach" />);
        hints.push(<KeyHint key="t" k="t" label="chat" />);
        hints.push(<KeyHint key="s" k="s" label="stop" />);
        break;
    }

    hints.push(sep(1));

    // Session management
    hints.push(<KeyHint key="fC" k="f/C" label="fork/clone" />);
    hints.push(<KeyHint key="W" k="W" label="worktree" />);
    hints.push(<KeyHint key="m" k="m" label="move" />);
    hints.push(<KeyHint key="M" k="M" label="mcp" />);
    hints.push(<KeyHint key="x" k="x" label="delete" />);
  }

  return hints;
}


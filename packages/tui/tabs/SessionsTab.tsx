import React, { useState, useMemo, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import * as core from "../../core/index.js";
import { ICON, COLOR } from "../constants.js";
import { ago } from "../helpers.js";
import { SplitPane } from "../components/SplitPane.js";
import { TreeList } from "../components/TreeList.js";
import { ThreadsPanel } from "../components/ThreadsPanel.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useSessionActions } from "../hooks/useSessionActions.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import { useAuthStatus } from "../hooks/useAuthStatus.js";
import { useGroupActions } from "../hooks/useGroupActions.js";
import { useFocus } from "../hooks/useFocus.js";
import { SessionDetail } from "./SessionDetail.js";
import { MoveToGroup } from "./MoveToGroup.js";
import { GroupManager } from "./GroupManager.js";
import { TalkToSession } from "./TalkToSession.js";
import { CloneSession } from "./CloneSession.js";
import type { StoreData } from "../hooks/useStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

type Overlay = "move" | "group" | "talk" | "inbox" | "clone" | "search" | null;

interface SessionsTabProps extends StoreData {
  async: AsyncState;
  pane: "left" | "right";
  onShowForm: () => void;
  onSelectionChange?: (session: core.Session | null) => void;
  formOverlay?: React.ReactNode;
  refresh: () => void;
}

export function SessionsTab({ sessions, refreshing, refresh, pane, unreadCounts, async: asyncState, onShowForm, onSelectionChange, formOverlay }: SessionsTabProps) {
  const focus = useFocus();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<core.SearchResult[] | null>(null);
  const status = useStatusMessage();

  // Top-level sessions, sorted by group name to match visual TreeList order
  const topLevel = useMemo(() => {
    const filtered = sessions.filter((s) => !s.parent_id);
    return filtered.sort((a, b) => {
      const ga = a.group_name ?? "";
      const gb = b.group_name ?? "";
      if (ga === "" && gb !== "") return -1;
      if (ga !== "" && gb === "") return 1;
      return ga.localeCompare(gb);
    });
  }, [sessions]);

  const hasOverlay = formOverlay || overlay;
  const { sel, setSel } = useListNavigation(topLevel.length, { active: pane === "left" && !hasOverlay });

  // Push/pop focus when overlay opens/closes
  useEffect(() => {
    if (overlay) focus.push(overlay);
    else focus.pop("move"), focus.pop("group"), focus.pop("talk"), focus.pop("inbox"), focus.pop("clone"), focus.pop("search");
  }, [overlay]);

  const selected = topLevel[sel] ?? null;

  // Notify parent of selection changes for status bar
  useEffect(() => {
    onSelectionChange?.(selected);
  }, [selected?.id, selected?.status, onSelectionChange]);

  // Helper: get all sessions in the same group as selected
  const selectedGroup = selected?.group_name ?? "";
  const groupSessions = useMemo(
    () => topLevel.filter(s => (s.group_name ?? "") === selectedGroup),
    [topLevel, selectedGroup],
  );

  // Memoize group list — depends on sessions (groups derived from session group_names + groups table)
  const groups = useMemo(() => core.getGroups(), [sessions]);

  const actions = useSessionActions(asyncState);
  const groupActions = useGroupActions(asyncState);

  // Auth status for selected session's compute target
  const selectedCompute = useMemo(
    () => selected?.compute_name ? core.getCompute(selected.compute_name) : null,
    [selected?.compute_name],
  );
  const authStatus = useAuthStatus(selectedCompute);

  useInput((input, key) => {
    if (formOverlay || hasOverlay) return;

    // Global keys — work regardless of selection
    if (input === "n") { onShowForm(); return; }
    if (input === "T") { setOverlay("inbox"); return; }
    if (input === "o") { setOverlay("group"); return; }

    // Cancel pending confirms on unrelated keys
    if (confirmComplete && input !== "d") {
      setConfirmComplete(false);
      status.clear();
    }
    if (confirmDelete && input !== "x") {
      setConfirmDelete(false);
      status.clear();
    }

    // Everything below requires a selected session
    if (!selected) return;

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
    } else if (input === "s") {
      if (!["completed", "failed", "stopped"].includes(selected.status)) {
        actions.stop(selected.id);
      }
    } else if (input === "r") {
      if (["blocked", "failed", "stopped", "completed"].includes(selected.status)) {
        actions.restart(selected.id);
      }
    } else if (input === "c") {
      // Fork: shallow copy (same config, fresh session)
      if (selected) {
        actions.fork(selected.id, selected.group_name);
      }
    } else if (input === "C") {
      // Clone: deep copy with resume (opens name prompt)
      if (selected) setOverlay("clone");
    } else if (input === "x") {
      if (confirmDelete) {
        actions.delete(selected.id);
        setConfirmDelete(false);
      } else {
        setConfirmDelete(true);
        status.show(`Delete '${selected.summary ?? selected.id}'? Press x again to confirm`);
      }
    } else if (input === "a") {
      if (selected?.session_id) {
        const sid = selected.session_id;
        const selectedId = selected.id;
        asyncState.run("Attaching...", async () => {
          const compute = selected?.compute_name ? core.getCompute(selected.compute_name) : null;
          const attachCompute = compute ?? core.getCompute("local")!;
          const { getProvider } = await import("../../compute/index.js");
          const provider = getProvider(attachCompute.provider);
          if (!provider) { status.show("Provider not found"); return; }

          const exists = await provider.checkSession(attachCompute, sid);
          if (!exists) {
            status.show(`Session not found on ${attachCompute.name}`);
            return;
          }

          const attachCmd = provider.getAttachCommand(attachCompute, selected!);
          if (attachCmd.length === 0) { status.show("Cannot attach to this session"); return; }

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
            // Spawn attach command — local tmux or SSH+tmux for remote
            const result = Bun.spawnSync(attachCmd, {
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
      if (selected) setOverlay("move");
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
      if (selected?.status === "running" || selected?.status === "waiting") setOverlay("talk");
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
        focus={overlay === "talk" || overlay === "inbox" ? "right" : pane}
        leftTitle="Sessions"
        rightTitle="Details"
        left={
          <TreeList
            items={topLevel}
            groupBy={s => s.group_name ?? ""}
            emptyGroups={groups}
            renderRow={(s) => {
              const icon = ICON[s.status] ?? "?";
              const summary = (s.summary ?? s.ticket ?? s.repo ?? "---").slice(0, 22).padEnd(22);
              const stage = (s.stage ? `stage:${s.stage}` : "---").padEnd(14);
              const age = ago(s.created_at).padStart(4);
              const unread = unreadCounts.get(s.id) ?? 0;
              const badge = unread > 0 ? ` (${unread})` : "";
              return `${icon} ${summary} ${stage} ${age}${badge}`;
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
                const childIcon = ICON[child.status] ?? "?";
                const childColor = (COLOR[child.status] ?? "white") as any;
                const childSummary = (child.summary ?? "---").slice(0, 20);
                return <Text key={child.id} dimColor>{"   | "}<Text color={childColor}>{childIcon}</Text>{` ${childSummary}`}</Text>;
              });
            }}
            sel={sel}
            emptyMessage="No sessions. Press n to create."
          />
        }
        right={
          formOverlay ? formOverlay
          : overlay === "clone" ? (
            <CloneSession
              session={selected}
              onDone={(name) => {
                setOverlay(null);
                if (!selected || !name) return;
                actions.clone(selected.id, name, selected.group_name);
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
                  asyncState.run("Moving session...", () => {
                    core.updateSession(selected.id, { group_name: group || null });
                    status.show(group ? `Moved to '${group}'` : "Removed from group");
                    refresh();
                  });
                }
                setOverlay(null);
              }}
            />
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


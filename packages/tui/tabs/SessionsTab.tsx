import React, { useState, useMemo, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { Session, SearchResult } from "../../core/index.js";
import { ICON } from "../constants.js";
import { getStatusColor } from "../helpers/colors.js";
import { ago } from "../helpers.js";
import { SplitPane } from "../components/SplitPane.js";
import { TreeList } from "../components/TreeList.js";
import { ThreadsPanel } from "../components/ThreadsPanel.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
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

interface SessionsTabProps extends StoreData {
  asyncState: AsyncState;
  pane: "left" | "right";
  onShowForm: () => void;
  onSelectionChange?: (session: Session | null) => void;
  formOverlay?: React.ReactNode;
  refresh: () => void;
}

export function SessionsTab({ sessions, refresh, pane, unreadCounts, asyncState, onShowForm, onSelectionChange, formOverlay }: SessionsTabProps) {
  const ark = useArkClient();
  const focus = useFocus();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const confirmation = useConfirmation();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
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
  const { sel, setSel } = useListNavigation(filteredTopLevel.length, { active: pane === "left" && !hasOverlay });

  // Push/pop focus when overlay opens/closes
  useEffect(() => {
    if (overlay) focus.push(overlay);
    else focus.pop("move"), focus.pop("group"), focus.pop("talk"), focus.pop("inbox"), focus.pop("fork"), focus.pop("search"), focus.pop("replay"), focus.pop("mcp"), focus.pop("skills"), focus.pop("settings"), focus.pop("find"), focus.pop("memory"), focus.pop("worktreeFinish");
  }, [overlay]);

  const selected = filteredTopLevel[sel] ?? null;

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

  // Memoize group list — depends on sessions (groups derived from session group_names + groups table)
  const [groups, setGroups] = useState<any[]>([]);
  useEffect(() => { ark.groupList().then(setGroups); }, [sessions]);

  const actions = useSessionActions(asyncState, status.show);
  const groupActions = useGroupActions(asyncState);

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
        actions.delete(selected.id);
        status.show("Deleted. Ctrl+Z to undo (90s)");
      }
    } else if (matchesHotkey("attach", input, key)) {
      if (selected?.session_id) {
        const sid = selected.session_id;
        const selectedId = selected.id;
        asyncState.run("Attaching...", async () => {
          const compute = selected?.compute_name ? await ark.computeRead(selected.compute_name).catch(() => null) : null;
          const attachCompute = compute ?? await ark.computeRead("local");
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
          process.stdout.write = (() => true) as typeof process.stdout.write;
          process.stderr.write = (() => true) as typeof process.stderr.write;
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
        setSel(0);
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
        leftTitle={statusFilter ? `Sessions [${statusFilter}]` : "Sessions"}
        rightTitle="Details"
        left={
          <TreeList
            items={filteredTopLevel}
            groupBy={s => s.group_name ?? ""}
            emptyGroups={groups}
            renderRow={(s) => {
              const cols = process.stdout.columns ?? 120;
              const summaryWidth = cols > 140 ? 45 : cols > 100 ? 30 : 20;
              const icon = ICON[s.status] ?? "?";
              const raw = s.summary ?? s.ticket ?? s.repo ?? "---";
              const summary = raw.length > summaryWidth ? raw.slice(0, summaryWidth - 1) + "\u2026" : raw.padEnd(summaryWidth);
              const stage = (s.stage ? `stage:${s.stage}` : "---").padEnd(14);
              const age = ago(s.created_at).padStart(4);
              const unread = unreadCounts.get(s.id) ?? 0;
              const badge = unread > 0 ? ` (${unread})` : "";
              return `${icon} ${summary} ${stage} ${age}${badge}`;
            }}
            renderColoredRow={(s) => {
              const cols = process.stdout.columns ?? 120;
              const summaryWidth = cols > 140 ? 45 : cols > 100 ? 30 : 20;
              const icon = ICON[s.status] ?? "?";
              const color = getStatusColor(s.status);
              const raw = s.summary ?? s.ticket ?? s.repo ?? "---";
              const summary = raw.length > summaryWidth ? raw.slice(0, summaryWidth - 1) + "\u2026" : raw.padEnd(summaryWidth);
              const stage = (s.stage ? `stage:${s.stage}` : "---").padEnd(14);
              const age = ago(s.created_at).padStart(4);
              const unread = unreadCounts.get(s.id) ?? 0;
              return (
                <Text>
                  {" "} <Text color={color}>{icon}</Text>{` ${summary}`}
                  {s.branch && <Text color="cyan">{` [${s.branch}]`}</Text>}
                  {` ${stage} ${age}`}
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
                const childColor = getStatusColor(child.status);
                const childSummary = (child.summary ?? "---").slice(0, 20);
                return <Text key={child.id} dimColor>{"   | "}<Text color={childColor}>{childIcon}</Text>{` ${childSummary}`}</Text>;
              });
            }}
            sel={sel}
            emptyMessage={statusFilter ? `No ${statusFilter} sessions. Press 0 to clear filter.` : "No sessions. Press n to create."}
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
                const idx = filteredTopLevel.findIndex(t => t.id === s.id);
                if (idx >= 0) setSel(idx);
              }}
              onClose={() => setOverlay(null)}
            />
          )
          : overlay === "worktreeFinish" ? (
            <Box flexDirection="column" padding={1}>
              <Text bold>Finish Worktree</Text>
              <Text> </Text>
              <Text>  <Text color="cyan" bold>M</Text> Merge locally</Text>
              <Text>  <Text color="cyan" bold>P</Text> Create PR on GitHub</Text>
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
                if (name === "attach" && selected?.session_id) {
                  // Trigger attach logic via left-pane handler
                  const sid = selected.session_id;
                  asyncState.run("Attaching...", async () => {
                    const compute = selected?.compute_name ? await ark.computeRead(selected.compute_name).catch(() => null) : null;
                    const attachCompute = compute ?? await ark.computeRead("local");
                    const { getProvider } = await import("../../compute/index.js");
                    const provider = getProvider(attachCompute.provider);
                    if (!provider) { status.show("Provider not found"); return; }
                    const exists = await provider.checkSession(attachCompute, sid);
                    if (!exists) { status.show(`Session not found on ${attachCompute.name}`); return; }
                    const attachCmd = provider.getAttachCommand(attachCompute, selected!);
                    if (attachCmd.length === 0) { status.show("Cannot attach to this session"); return; }
                    const origWrite = process.stdout.write.bind(process.stdout);
                    const origErrWrite = process.stderr.write.bind(process.stderr);
                    process.stdout.write = (() => true) as typeof process.stdout.write;
                    process.stderr.write = (() => true) as typeof process.stderr.write;
                    setTimeout(() => {
                      process.stdout.write = origWrite;
                      process.stderr.write = origErrWrite;
                      try { process.stdin.setRawMode(false); } catch {}
                      process.stdout.write("\x1b[?1049l");
                      process.stdout.write("\x1b[?25h");
                      const result = Bun.spawnSync(attachCmd, {
                        stdin: "inherit", stdout: "inherit", stderr: "inherit",
                        env: { ...process.env, TERM: "xterm-256color" },
                      });
                      try { process.stdin.setRawMode(true); } catch {}
                      process.stdout.write("\x1b[?25l");
                      process.stdout.write("\x1b[2J\x1b[H");
                      status.show("Detached from session");
                    }, 100);
                  });
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
      {status.message && (
        <Box>
          <Text color="cyan">{` ${status.message}`}</Text>
        </Box>
      )}
    </Box>
  );
}


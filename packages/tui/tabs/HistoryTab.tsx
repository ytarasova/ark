import React, { useState, useEffect, useMemo, useRef } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import type { ClaudeSession, SearchResult } from "../../core/index.js";
import { ago } from "../helpers.js";
import { sanitizeForTerminal } from "../helpers/sessionFormatting.js";
import { SplitPane } from "../components/SplitPane.js";
import { TreeList } from "../components/TreeList.js";
import { ScrollBox } from "../components/ScrollBox.js";
import { KeyValue } from "../components/KeyValue.js";
import { TextInputEnhanced } from "../components/TextInputEnhanced.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import { useFocus } from "../hooks/useFocus.js";
import { useArkClient } from "../hooks/useArkClient.js";
import type { StoreData } from "../hooks/useArkStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

interface HistoryTabProps extends StoreData {
  pane: "left" | "right";
  asyncState: AsyncState;
  onImport?: (prefill: { name?: string; repo?: string; claudeSessionId?: string }) => void;
}

const RECENT_LIMIT = 100;

interface HistoryItem {
  type: "ark" | "claude";
  id: string;
  date: string;
  sortKey: string; // full ISO timestamp for sorting
  summary: string;
  messageCount: number;
  arkSession?: any;
  claudeSession?: ClaudeSession;
}

function buildHistoryItems(arkSessions: any[], claudeSessions: ClaudeSession[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  const boundClaudeIds = new Set(arkSessions.map(s => s.claude_session_id).filter(Boolean));

  for (const s of arkSessions) {
    const ts = s.updated_at || s.created_at || "";
    items.push({
      type: "ark", id: s.id,
      date: ts.slice(0, 10),
      sortKey: ts,
      summary: s.summary || s.ticket || "",
      messageCount: 0, arkSession: s,
    });
  }

  for (const cs of claudeSessions) {
    if (boundClaudeIds.has(cs.sessionId)) continue;
    const ts = cs.lastActivity || cs.timestamp || "";
    items.push({
      type: "claude", id: cs.sessionId,
      date: ts.slice(0, 10),
      sortKey: ts,
      summary: cs.summary || cs.project || "",
      messageCount: cs.messageCount, claudeSession: cs,
    });
  }

  // Sort all items by timestamp, most recent first
  items.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  return items;
}

export function HistoryTab({ sessions: arkSessions, pane, asyncState, refresh, onImport }: HistoryTabProps) {
  const ark = useArkClient();
  const focus = useFocus();
  const [claudeSessions, setClaudeSessions] = useState<ClaudeSession[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [mode, setMode] = useState<"recent" | "search">("recent");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInputActive, setSearchInputActive] = useState(false);
  const status = useStatusMessage();

  // Push/pop focus when search input is active (left pane stays focused)
  useEffect(() => {
    if (searchInputActive) focus.push("search", "left");
    else focus.pop("search");
  }, [searchInputActive]);

  const historyItems = useMemo(
    () => buildHistoryItems(arkSessions, claudeSessions),
    [arkSessions, claudeSessions],
  );

  const { sel } = useListNavigation(
    mode === "recent" ? historyItems.length : searchResults.length,
    { active: pane === "left" && !searchInputActive },
  );
  const selectedItem = mode === "recent" ? historyItems[sel] ?? null : null;
  const selectedSearchResult = mode === "search" ? searchResults[sel] ?? null : null;

  // Derive a display ID for the detail panel (works for both modes)
  const detailSessionId = selectedItem?.id ?? selectedSearchResult?.sessionId ?? null;

  // Load conversation preview from FTS5 index (fast SQLite read, no file I/O)
  const [conversationPreview, setConversationPreview] = useState<any[]>([]);
  useEffect(() => {
    setConversationPreview([]); // Clear immediately to avoid stale data
    if (!detailSessionId) return;
    const convId = selectedItem?.claudeSession?.sessionId || selectedItem?.arkSession?.claude_session_id || detailSessionId;
    ark.sessionConversation(convId, 50).then((turns: any[]) => {
      setConversationPreview(turns);
    }).catch(() => setConversationPreview([]));
  }, [detailSessionId]);

  // Stable ref for asyncState so the mount effect does not re-trigger on every render
  const asyncStateRef = useRef(asyncState);
  asyncStateRef.current = asyncState;

  // Load from cache (instant), then always refresh in background
  useEffect(() => {
    ark.historyList(RECENT_LIMIT).then(setClaudeSessions);

    // Always refresh cache in background -- picks up new sessions + fixes summaries
    asyncStateRef.current.run("Refreshing...", async () => {
      await ark.historyRefresh();
      const items = await ark.historyList(RECENT_LIMIT);
      setClaudeSessions(items);
    });
  }, [ark]);

  useInput((input, key) => {
    if (pane !== "left") return;

    if (key.return && mode === "recent" && selectedItem?.type === "claude" && selectedItem.claudeSession) {
      const cs = selectedItem.claudeSession;
      onImport?.({
        name: cs.summary?.slice(0, 100) || `import-${cs.sessionId.slice(0, 8)}`,
        repo: cs.project,
        claudeSessionId: cs.sessionId,
      });
      return;
    }

    if (input === "/" && !searchInputActive) {
      setMode("search"); setSearchQuery(""); setSearchResults([]);
      setSearchInputActive(true);
      return;
    }

    if (key.escape && mode === "search") {
      if (searchInputActive) {
        // Esc while typing: close input, keep results navigable
        setSearchInputActive(false);
      } else {
        // Esc while browsing results: back to recent
        setMode("recent"); setSearchQuery(""); setSearchResults([]);
      }
      return;
    }

    // R (shift) — force full rebuild (clear cache first)
    if (input === "R" && mode !== "search") {
      asyncState.run("Full rebuild...", async () => {
        status.show("Rebuilding...");
        const result = await ark.historyRebuildFts();
        setClaudeSessions(result.items);
        status.show(`Rebuilt: ${result.sessionCount} sessions, ${result.indexCount} indexed`);
      });
      return;
    }

    // r — incremental refresh + reindex
    if (input === "r" && mode !== "search") {
      asyncState.run("Refreshing...", async () => {
        status.show("Refreshing and indexing...");
        const result = await ark.historyRefreshAndIndex();
        setClaudeSessions(result.items);
        status.show(`${result.sessionCount} sessions, ${result.indexCount} indexed`);
      });
      return;
    }
  });

  const doSearch = (query: string) => {
    if (!query.trim()) return;
    setSearchInputActive(false); // Release focus so j/k navigate results
    asyncState.run("Searching...", async () => {
      const results = await ark.historySearch(query, 20);
      setSearchResults(results);
      status.show(`Found ${results.length} result(s)`);
    });
  };

  return (
    <Box flexDirection="column" flexGrow={1}>
      <SplitPane
        focus={pane}
        leftTitle={mode === "recent" ? `History (${historyItems.length})` : `Search (${searchResults.length})`}
        rightTitle="Details"
        left={
          <Box flexDirection="column">
            {mode === "search" && (
              searchInputActive ? (
                <Box>
                  <Text color="cyan">{"/"}</Text>
                  <TextInputEnhanced
                    value={searchQuery}
                    onChange={setSearchQuery}
                    onSubmit={() => doSearch(searchQuery)}
                    placeholder="search sessions and transcripts..."
                  />
                </Box>
              ) : (
                <Text dimColor>{`  /${searchQuery}`}</Text>
              )
            )}
            {asyncState.loading && historyItems.length === 0 ? (
              <Text><Spinner type="dots" /> <Text dimColor>{asyncState.label || "loading..."}</Text></Text>
            ) : mode === "recent" ? (
              <TreeList
                items={historyItems}
                renderRow={(item) => {
                  const project = item.claudeSession?.project?.split("/").pop() ?? "";
                  const label = item.summary ? item.summary.slice(0, 30) : project || item.id.slice(0, 8);
                  const msgs = item.messageCount > 0 ? `${item.messageCount}msgs` : "";
                  const time = ago(item.sortKey);
                  return `${label}  ${msgs}  ${time}`;
                }}
                renderColoredRow={(item) => {
                  const project = item.claudeSession?.project?.split("/").pop() ?? "";
                  const label = item.summary ? item.summary.slice(0, 30) : project || item.id.slice(0, 8);
                  const msgs = item.messageCount > 0 ? `${item.messageCount} msgs` : "";
                  const time = ago(item.sortKey);
                  return (
                    <Text wrap="truncate">
                      {"  "}
                      {item.type === "ark" && <Text color="green" bold>{"ARK "}</Text>}
                      <Text>{label}</Text>
                      {"  "}
                      <Text dimColor>{msgs}  {time}</Text>
                    </Text>
                  );
                }}
                sel={sel}
                emptyMessage="  No sessions found."
              />
            ) : asyncState.loading ? (
              <Text><Spinner type="dots" /> <Text dimColor>{asyncState.label || "searching..."}</Text></Text>
            ) : (
              <TreeList
                items={searchResults}
                renderRow={(r) => {
                  return `${r.source.slice(0, 4).padEnd(4)} ${r.match?.slice(0, 50) || ""}`;
                }}
                renderColoredRow={(r) => (
                  <Text wrap="truncate">
                    {"  "}<Text color={r.source === "transcript" ? "magenta" : "cyan"}>{r.source.slice(0, 4).padEnd(4)}</Text>
                    {` ${r.match?.slice(0, 50) || ""}`}
                  </Text>
                )}
                sel={sel}
                emptyMessage="  No results found."
              />
            )}
          </Box>
        }
        right={
          <HistoryDetail item={selectedItem} searchResult={selectedSearchResult} pane={pane} conversation={conversationPreview} />
        }
      />
    </Box>
  );
}

// -- Detail ------------------------------------------------------------------

function HistoryDetail({ item, searchResult, pane, conversation }: { item: HistoryItem | null; searchResult?: SearchResult | null; pane: string; conversation: any[] }) {
  const detailId = item?.id ?? searchResult?.sessionId ?? null;

  if (!detailId) {
    return <Box flexGrow={1}><Text dimColor>{"  No session selected."}</Text></Box>;
  }

  return <HistoryDetailContent item={item} searchResult={searchResult} pane={pane} conversation={conversation} detailId={detailId} />;
}

function HistoryDetailContent({ item, searchResult, pane, conversation, detailId }: { item: HistoryItem | null; searchResult?: SearchResult | null; pane: string; conversation: any[]; detailId: string }) {
  const metadata = item ? (
    item.type === "ark" ? (
      <>
        <KeyValue label="Name">{item.arkSession.summary || item.arkSession.ticket || "(unnamed)"}</KeyValue>
        <KeyValue label="ID">{item.arkSession.id}</KeyValue>
        <KeyValue label="Status">{item.arkSession.status}</KeyValue>
        <KeyValue label="Flow">{item.arkSession.flow}{item.arkSession.stage ? ` / ${item.arkSession.stage}` : ""}</KeyValue>
        {item.arkSession.repo && <KeyValue label="Repo">{item.arkSession.repo}</KeyValue>}
        {item.arkSession.claude_session_id && <KeyValue label="Claude ID">{item.arkSession.claude_session_id}</KeyValue>}
        <KeyValue label="Age">{ago(item.arkSession.updated_at || item.arkSession.created_at)}</KeyValue>
      </>
    ) : (
      <>
        <KeyValue label="Session ID">{item.claudeSession!.sessionId}</KeyValue>
        <KeyValue label="Project">{item.claudeSession!.project}</KeyValue>
        <KeyValue label="Messages">{String(item.claudeSession!.messageCount)}</KeyValue>
        <KeyValue label="Active">{ago(item.claudeSession!.lastActivity || item.claudeSession!.timestamp)}</KeyValue>
      </>
    )
  ) : searchResult ? (
    <>
      <KeyValue label="Session">{searchResult.sessionId}</KeyValue>
      <KeyValue label="Source">{searchResult.source}</KeyValue>
      {searchResult.match && <KeyValue label="Match">{searchResult.match.slice(0, 80)}</KeyValue>}
    </>
  ) : null;

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Fixed metadata section */}
      <Box flexDirection="column" paddingBottom={1}>
        {metadata}
      </Box>
      {/* Scrollable conversation section */}
      <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor="gray" borderTop={true} borderBottom={false} borderLeft={false} borderRight={false}>
        <ScrollBox active={pane === "right"} reserveRows={18} resetKey={detailId}>
          <ConversationScrollContent turns={conversation} />
        </ScrollBox>
      </Box>
    </Box>
  );
}

function ConversationScrollContent({ turns }: { turns: any[] }) {
  const filtered = (turns || []).filter((t: any) => {
    if (!t || !t.content || t.content.length < 2) return false;
    if (t.role !== "user" && t.role !== "assistant") return false;
    const c = t.content;
    if (c.startsWith("<channel ") || c.startsWith("You are the ") || c.startsWith("Session ")) return false;
    return true;
  });

  if (filtered.length === 0) {
    return <Text dimColor>{"  No conversation."}</Text>;
  }

  return (
    <>
      <Text dimColor>{`  Conversation (${filtered.length})`}</Text>
      <Text> </Text>
      {filtered.map((turn: any, idx: number) => {
        const isUser = turn.role === "user";
        const content = sanitizeForTerminal((turn.content || "").trim(), 120);
        const label = isUser ? " You " : " Agent ";
        const time = turn.timestamp ? `  ${ago(turn.timestamp)}` : "";
        return (
          <Box key={idx} flexDirection="column" marginBottom={1} paddingLeft={isUser ? 2 : 0}>
            <Text>
              <Text color={isUser ? "cyan" : "green"} bold>{label}</Text>
              {time ? <Text dimColor>{time}</Text> : null}
            </Text>
            <Text wrap="wrap" color={isUser ? "white" : undefined} dimColor={!isUser}>
              {content}
            </Text>
          </Box>
        );
      })}
    </>
  );
}

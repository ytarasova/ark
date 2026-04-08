import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import type { ClaudeSession, SearchResult } from "../../core/index.js";
import { ago } from "../helpers.js";
import { SplitPane } from "../components/SplitPane.js";
import { TreeList } from "../components/TreeList.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { DetailPanel } from "../components/DetailPanel.js";
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
      summary: cs.summary || "",
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
  const status = useStatusMessage();

  // Push/pop focus when search mode is active
  useEffect(() => {
    if (mode === "search") focus.push("search");
    else focus.pop("search");
  }, [mode]);

  const historyItems = buildHistoryItems(arkSessions, claudeSessions);

  const { sel } = useListNavigation(
    mode === "recent" ? historyItems.length : searchResults.length,
    { active: pane === "left" && mode !== "search" },
  );
  const selectedItem = mode === "recent" ? historyItems[sel] ?? null : null;

  // Load conversation preview from FTS5 index (fast SQLite read, no file I/O)
  const [conversationPreview, setConversationPreview] = useState<any[]>([]);
  useEffect(() => {
    if (!selectedItem) {
      setConversationPreview([]);
      return;
    }
    // Use claude session ID for Claude sessions, ark session ID for ark sessions
    const convId = selectedItem.claudeSession?.sessionId || selectedItem.arkSession?.claude_session_id || selectedItem.id;
    ark.sessionConversation(convId, 50).then((turns: any[]) => {
      setConversationPreview(turns);
    }).catch(() => setConversationPreview([]));
  }, [selectedItem?.id]);

  // Load from cache (instant), then always refresh in background
  useEffect(() => {
    ark.historyList(RECENT_LIMIT).then(setClaudeSessions);

    // Always refresh cache in background — picks up new sessions + fixes summaries
    asyncState.run("Refreshing...", async () => {
      await ark.historyRefresh();
      const items = await ark.historyList(RECENT_LIMIT);
      setClaudeSessions(items);
    });
  }, []);

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

    if (input === "s" && mode !== "search") {
      setMode("search"); setSearchQuery(""); setSearchResults([]);
      return;
    }

    if (key.escape && mode === "search") { setMode("recent"); setSearchQuery(""); setSearchResults([]); return; }

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
              <Box>
                <Text color="cyan">{"/"}</Text>
                <TextInputEnhanced
                  value={searchQuery}
                  onChange={setSearchQuery}
                  onSubmit={() => doSearch(searchQuery)}
                  placeholder="search sessions and transcripts..."
                />
              </Box>
            )}
            {asyncState.loading && historyItems.length === 0 ? (
              <Text><Spinner type="dots" /> <Text dimColor>{asyncState.label || "loading..."}</Text></Text>
            ) : mode === "recent" ? (
              <TreeList
                items={historyItems}
                renderRow={(item) => {
                  const label = item.summary || (item.claudeSession?.project.split("/").pop() ?? item.id.slice(0, 8));
                  const tag = item.type === "ark" ? " ARK " : "     ";
                  return `${item.date.slice(5)}${tag}${label}`;
                }}
                renderColoredRow={(item) => {
                  const label = item.summary || (item.claudeSession?.project.split("/").pop() ?? item.id.slice(0, 8));
                  const tag = item.type === "ark" ? " ARK " : "     ";
                  return (
                    <Text wrap="truncate">
                      {"  "}<Text color={item.type === "ark" ? "green" : "dim"}>{item.date.slice(5)}</Text>
                      <Text color={item.type === "ark" ? "green" : undefined} bold={item.type === "ark"}>{tag}</Text>
                      {label}
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
          <HistoryDetail item={selectedItem} pane={pane} conversation={conversationPreview} />
        }
      />
    </Box>
  );
}

// -- Detail ------------------------------------------------------------------

function HistoryDetail({ item, pane, conversation }: { item: HistoryItem | null; pane: string; conversation: any[] }) {
  if (!item) return <Box flexGrow={1}><Text dimColor>{"  No session selected."}</Text></Box>;

  if (item.type === "ark") {
    const s = item.arkSession;
    return (
      <DetailPanel active={pane === "right"}>
        <KeyValue label="Name">{s.summary || s.ticket || "(unnamed)"}</KeyValue>
        <KeyValue label="ID">{s.id}</KeyValue>
        <KeyValue label="Status">{s.status}</KeyValue>
        <KeyValue label="Flow">{s.flow}{s.stage ? ` / ${s.stage}` : ""}</KeyValue>
        {s.repo && <KeyValue label="Repo">{s.repo}</KeyValue>}
        {s.claude_session_id && <KeyValue label="Claude ID">{s.claude_session_id}</KeyValue>}
        <KeyValue label="Age">{ago(s.updated_at || s.created_at)}</KeyValue>
      </DetailPanel>
    );
  }

  const cs = item.claudeSession!;
  return (
    <DetailPanel active={pane === "right"}>
      <KeyValue label="Session ID">{cs.sessionId}</KeyValue>
      <KeyValue label="Project">{cs.project}</KeyValue>
      <KeyValue label="Messages">{String(cs.messageCount)}</KeyValue>
      <KeyValue label="Active">{ago(cs.lastActivity || cs.timestamp)}</KeyValue>
      <KeyValue label="File">{cs.transcriptPath}</KeyValue>

      {conversation.length > 0 && (
        <>
          <Text> </Text>
          <SectionHeader title={`Recent conversation (${conversation.length})`} />
          {conversation.map((turn: any, idx: number) => {
            const isUser = turn.role === "user";
            const content = (turn.content || "").slice(0, 300) + ((turn.content || "").length > 300 ? "..." : "");
            const label = isUser ? "You" : "Agent";
            const ts = turn.timestamp ? ` ${ago(turn.timestamp)}` : "";
            return (
              <Box key={`conv-${idx}`} flexDirection="column" marginBottom={1}
                paddingLeft={isUser ? 4 : 0}
              >
                <Text bold color={isUser ? "cyan" : "green"}>
                  {isUser ? "  " : ""}{label}<Text dimColor>{ts}</Text>
                </Text>
                <Text wrap="wrap" dimColor={!isUser} color={isUser ? "white" : undefined}>
                  {isUser ? "  " : ""}{content}
                </Text>
              </Box>
            );
          })}
        </>
      )}

    </DetailPanel>
  );
}

import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import * as core from "../../core/index.js";
import { ago } from "../helpers.js";
import { SplitPane } from "../components/SplitPane.js";
import { ScrollBox } from "../components/ScrollBox.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { KeyValue } from "../components/KeyValue.js";
import { TextInputEnhanced } from "../components/TextInputEnhanced.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import type { StoreData } from "../hooks/useStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

interface HistoryTabProps extends StoreData {
  pane: "left" | "right";
  async: AsyncState;
  onOverlayChange?: (overlay: string | null) => void;
  onListLength?: (length: number) => void;
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
  claudeSession?: core.ClaudeSession;
}

function buildHistoryItems(arkSessions: any[], claudeSessions: core.ClaudeSession[]): HistoryItem[] {
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

export function HistoryTab({ sessions: arkSessions, pane, async: asyncState, refresh, onOverlayChange, onListLength, onImport }: HistoryTabProps) {
  const [claudeSessions, setClaudeSessions] = useState<core.ClaudeSession[]>([]);
  const [searchResults, setSearchResults] = useState<core.SearchResult[]>([]);
  const [mode, setMode] = useState<"recent" | "search">("recent");
  const [searchQuery, setSearchQuery] = useState("");
  const status = useStatusMessage();

  // Signal parent which overlay is active (for status bar hints)
  useEffect(() => {
    onOverlayChange?.(mode === "search" ? "search" : null);
  }, [mode]);

  const historyItems = buildHistoryItems(arkSessions, claudeSessions);

  // Report list length to parent for conditional scroll hints
  useEffect(() => { onListLength?.(historyItems.length); }, [historyItems.length]);
  const { sel } = useListNavigation(
    mode === "recent" ? historyItems.length : searchResults.length,
    { active: pane === "left" && mode !== "search" },
  );
  const selectedItem = mode === "recent" ? historyItems[sel] ?? null : null;

  // Load conversation preview from FTS5 index (fast SQLite read, no file I/O)
  const [conversationPreview, setConversationPreview] = useState<string[]>([]);
  useEffect(() => {
    if (!selectedItem) {
      setConversationPreview([]);
      return;
    }
    // Use claude session ID for Claude sessions, ark session ID for ark sessions
    const convId = selectedItem.claudeSession?.sessionId || selectedItem.arkSession?.claude_session_id || selectedItem.id;
    try {
      const turns = core.getSessionConversation(convId, { limit: 20 });
      setConversationPreview(turns.map(t => {
        const role = t.role === "user" ? "You" : "Claude";
        return `${role}: ${t.content}`;
      }));
    } catch { setConversationPreview([]); }
  }, [selectedItem?.id]);

  // Load from cache (instant), then always refresh in background
  useEffect(() => {
    const cached = core.listClaudeSessions({ limit: RECENT_LIMIT });
    setClaudeSessions(cached);

    // Always refresh cache in background — picks up new sessions + fixes summaries
    asyncState.run("Refreshing...", async () => {
      await core.refreshClaudeSessionsCache();
      setClaudeSessions(core.listClaudeSessions({ limit: RECENT_LIMIT }));
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

    if (key.escape && mode === "search") { setMode("recent"); return; }

    // R (shift) — force full rebuild (clear cache first)
    if (input === "R" && mode !== "search") {
      asyncState.run("Full rebuild...", async () => {
        const db = (await import("../../core/store.js")).getDb();
        db.exec("DELETE FROM claude_sessions_cache");
        db.exec("DELETE FROM transcript_index");
        const sessionCount = await core.refreshClaudeSessionsCache({
          onProgress: (done, total) => { status.show(`Scanning ${done}/${total} files...`); },
        });
        const indexCount = await core.indexTranscripts({
          onProgress: (indexed, files) => { status.show(`Indexing ${files} files, ${indexed} entries...`); },
        });
        const sessions = core.listClaudeSessions({ limit: RECENT_LIMIT });
        setClaudeSessions(sessions);
        status.show(`Rebuilt: ${sessionCount} sessions, ${indexCount} indexed`);
      });
      return;
    }

    // r — incremental refresh + reindex
    if (input === "r" && mode !== "search") {
      asyncState.run("Refreshing...", async () => {
        const sessionCount = await core.refreshClaudeSessionsCache({
          onProgress: (done, total) => { status.show(`Scanning ${done}/${total} files...`); },
        });
        status.show(`Scanned ${sessionCount} sessions, indexing...`);
        const indexCount = await core.indexTranscripts({
          onProgress: (indexed, files) => { status.show(`Indexing ${files} files, ${indexed} entries...`); },
        });
        const sessions = core.listClaudeSessions({ limit: RECENT_LIMIT });
        setClaudeSessions(sessions);
        status.show(`${sessionCount} sessions, ${indexCount} indexed`);
      });
      return;
    }
  });

  const doSearch = (query: string) => {
    if (!query.trim()) return;
    asyncState.run("Searching...", async () => {
      const dbResults = core.searchSessions(query, { limit: 20 });
      const txResults = core.searchTranscripts(query, { limit: 20 });
      setSearchResults([...dbResults, ...txResults]);
      status.show(`Found ${dbResults.length + txResults.length} result(s)`);
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
                  placeholder="search transcripts..."
                />
              </Box>
            )}
            {asyncState.loading && historyItems.length === 0 ? (
              <Text><Spinner type="dots" /> <Text dimColor>{asyncState.label || "loading..."}</Text></Text>
            ) : mode === "recent" ? (
              historyItems.length === 0 ? (
                <Text dimColor>{"No sessions found"}</Text>
              ) : (
                <ScrollBox followIndex={sel} active={false} reserveRows={9}>
                  {historyItems.map((item, idx) => {
                    const label = item.summary || (item.claudeSession?.project.split("/").pop() ?? item.id.slice(0, 8));
                    const tag = item.type === "ark" ? " ARK " : "     ";
                    return (
                      <Text key={item.id} wrap="truncate">
                        {idx === sel ? ">" : " "}
                        <Text color={item.type === "ark" ? "green" : "dim"}>{item.date.slice(5)}</Text>
                        <Text color={item.type === "ark" ? "green" : undefined} bold={item.type === "ark"}>{tag}</Text>
                        {label}
                      </Text>
                    );
                  })}
                </ScrollBox>
              )
            ) : (
              searchResults.length === 0 ? (
                <Text dimColor>{"No results"}</Text>
              ) : (
                <ScrollBox followIndex={sel} active={false} reserveRows={9}>
                  {searchResults.map((r, idx) => (
                    <Text key={`${r.sessionId}-${idx}`} wrap="truncate">
                      {idx === sel ? ">" : " "}
                      <Text color={r.source === "transcript" ? "magenta" : "cyan"}>{r.source.slice(0, 4).padEnd(4)}</Text>
                      {` ${r.match?.slice(0, 50) || ""}`}
                    </Text>
                  ))}
                </ScrollBox>
              )
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

function HistoryDetail({ item, pane, conversation }: { item: HistoryItem | null; pane: string; conversation: string[] }) {
  if (!item) return <Box flexGrow={1}><Text dimColor>{"Select a session"}</Text></Box>;

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
          <SectionHeader title="Recent conversation" />
          {conversation.map((msg, i) => {
            const isUser = msg.startsWith("You:");
            return (
              <Text key={i} wrap="wrap" color={isUser ? "cyan" : undefined} dimColor={!isUser}>
                {msg}
              </Text>
            );
          })}
        </>
      )}

    </DetailPanel>
  );
}

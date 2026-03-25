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
}

const RECENT_LIMIT = 100;

interface HistoryItem {
  type: "ark" | "claude";
  id: string;
  date: string;
  summary: string;
  messageCount: number;
  arkSession?: any;
  claudeSession?: core.ClaudeSession;
}

function buildHistoryItems(arkSessions: any[], claudeSessions: core.ClaudeSession[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  const boundClaudeIds = new Set(arkSessions.map(s => s.claude_session_id).filter(Boolean));

  for (const s of arkSessions) {
    items.push({
      type: "ark", id: s.id,
      date: (s.updated_at || s.created_at || "").slice(0, 10),
      summary: s.summary || s.ticket || "(no summary)",
      messageCount: 0, arkSession: s,
    });
  }

  for (const cs of claudeSessions) {
    if (boundClaudeIds.has(cs.sessionId)) continue;
    items.push({
      type: "claude", id: cs.sessionId,
      date: (cs.lastActivity || cs.timestamp || "").slice(0, 10),
      summary: cs.summary || "(no summary)",
      messageCount: cs.messageCount, claudeSession: cs,
    });
  }

  return items;
}

export function HistoryTab({ sessions: arkSessions, pane, async: asyncState, refresh, onOverlayChange }: HistoryTabProps) {
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
  const { sel } = useListNavigation(
    mode === "recent" ? historyItems.length : searchResults.length,
    { active: pane === "left" && mode !== "search" },
  );
  const selectedItem = mode === "recent" ? historyItems[sel] ?? null : null;

  // Load conversation preview for selected Claude session
  const [conversationPreview, setConversationPreview] = useState<string[]>([]);
  useEffect(() => {
    if (!selectedItem?.claudeSession?.transcriptPath) {
      setConversationPreview([]);
      return;
    }
    // Load last few messages from transcript (async to not block)
    asyncState.run("Loading preview...", async () => {
      await new Promise(r => setTimeout(r, 0));
      const { readFileSync, existsSync } = await import("fs");
      const path = selectedItem.claudeSession!.transcriptPath;
      if (!existsSync(path)) { setConversationPreview([]); return; }
      try {
        const content = readFileSync(path, "utf-8");
        const lines = content.split("\n").filter(l => l.trim());
        const msgs: string[] = [];
        // Read last 20 lines, extract user/assistant messages
        const recent = lines.slice(-200);
        for (const line of recent) {
          try {
            const entry = JSON.parse(line);
            if (entry.type !== "user" && entry.type !== "assistant") continue;
            const msg = entry.message;
            let text = "";
            if (typeof msg?.content === "string") text = msg.content;
            else if (Array.isArray(msg?.content)) {
              text = msg.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
            }
            text = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            if (!text || text.startsWith("Caveat:")) continue;
            const role = entry.type === "user" ? "You" : "Claude";
            msgs.push(`${role}: ${text.slice(0, 150)}`);
          } catch {}
        }
        setConversationPreview(msgs.slice(-15)); // last 15 messages
      } catch { setConversationPreview([]); }
    });
  }, [selectedItem?.id]);

  // Load from cache (instant), then refresh in background
  useEffect(() => {
    // Instant read from SQLite cache
    const cached = core.listClaudeSessions({ limit: RECENT_LIMIT });
    setClaudeSessions(cached);

    // Background refresh if cache is empty
    if (cached.length === 0) {
      asyncState.run("Scanning Claude sessions...", async () => {
        await core.refreshClaudeSessionsCache();
        setClaudeSessions(core.listClaudeSessions({ limit: RECENT_LIMIT }));
      });
    }
  }, []);

  useInput((input, key) => {
    if (pane !== "left") return;

    if (key.return && mode === "recent" && selectedItem?.type === "claude" && selectedItem.claudeSession) {
      const cs = selectedItem.claudeSession;
      asyncState.run("Importing session...", () => {
        const s = core.startSession({
          summary: cs.summary?.slice(0, 100) || `Import ${cs.sessionId.slice(0, 8)}`,
          repo: cs.project, workdir: cs.project, flow: "bare",
        });
        core.updateSession(s.id, { claude_session_id: cs.sessionId });
        status.show(`Imported ${cs.sessionId.slice(0, 8)}`);
        refresh();
      });
      return;
    }

    if (input === "s" && mode !== "search") {
      setMode("search"); setSearchQuery(""); setSearchResults([]);
      return;
    }

    if (key.escape && mode === "search") { setMode("recent"); return; }

    // r — refresh cache + reindex transcripts
    if (input === "r" && mode !== "search") {
      asyncState.run("Refreshing...", async () => {
        const sessionCount = await core.refreshClaudeSessionsCache();
        const indexCount = await core.indexTranscripts({
          onProgress: (indexed, files) => { status.show(`Indexing... ${files} files, ${indexed} entries`); },
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
                <ScrollBox followIndex={sel} active={false}>
                  {historyItems.map((item, idx) => (
                    <Text key={item.id + idx} wrap="truncate">
                      {idx === sel ? ">" : " "}
                      <Text color={item.type === "ark" ? "green" : "dim"}>{item.date.slice(5)}</Text>
                      {` ${item.summary || "(no summary)"}`}
                    </Text>
                  ))}
                </ScrollBox>
              )
            ) : (
              searchResults.length === 0 ? (
                <Text dimColor>{"No results"}</Text>
              ) : (
                <ScrollBox followIndex={sel} active={false}>
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
  if (!item) return <Text dimColor>{"Select a session"}</Text>;

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

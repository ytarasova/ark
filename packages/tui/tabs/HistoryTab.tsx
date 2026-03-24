import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import * as core from "../../core/index.js";
import { ago } from "../helpers.js";
import { SplitPane } from "../components/SplitPane.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { TreeList } from "../components/TreeList.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { KeyValue } from "../components/KeyValue.js";
import { TextInputEnhanced } from "../components/form/TextInputEnhanced.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useStatusMessage } from "../hooks/useStatusMessage.js";
import type { StoreData } from "../hooks/useStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

interface HistoryTabProps extends StoreData {
  pane: "left" | "right";
  async: AsyncState;
}

const RECENT_LIMIT = 20;

/** Unified history item: either an Ark session or an orphan Claude session */
interface HistoryItem {
  type: "ark" | "claude";
  id: string;
  date: string;
  project: string;
  summary: string;
  messageCount: number;
  arkSession?: any; // core.Session
  claudeSession?: core.ClaudeSession;
}

function buildHistoryItems(arkSessions: any[], claudeSessions: core.ClaudeSession[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  const boundClaudeIds = new Set(arkSessions.map(s => s.claude_session_id).filter(Boolean));

  // Ark sessions first (most recent)
  for (const s of arkSessions) {
    items.push({
      type: "ark",
      id: s.id,
      date: (s.updated_at || s.created_at || "").slice(0, 10),
      project: (s.repo || s.workdir || "").split("/").slice(-2).join("/"),
      summary: s.summary || s.ticket || "(no summary)",
      messageCount: 0,
      arkSession: s,
    });
  }

  // Orphan Claude sessions (not already bound to an Ark session)
  for (const cs of claudeSessions) {
    if (boundClaudeIds.has(cs.sessionId)) continue;
    items.push({
      type: "claude",
      id: cs.sessionId,
      date: (cs.lastActivity || cs.timestamp || "").slice(0, 10),
      project: cs.project.split("/").slice(-2).join("/"),
      summary: cs.summary || "(no summary)",
      messageCount: cs.messageCount,
      claudeSession: cs,
    });
  }

  return items;
}

export function HistoryTab({ sessions: arkSessions, pane, async: asyncState, refresh }: HistoryTabProps) {
  const [claudeSessions, setClaudeSessions] = useState<core.ClaudeSession[]>([]);
  const [searchResults, setSearchResults] = useState<core.SearchResult[]>([]);
  const [mode, setMode] = useState<"recent" | "search">("recent");
  const [searchQuery, setSearchQuery] = useState("");
  const status = useStatusMessage();

  const historyItems = buildHistoryItems(arkSessions, claudeSessions);
  const items = mode === "recent" ? historyItems : searchResults as any[];
  const { sel } = useListNavigation(items.length, { active: pane === "left" && mode !== "search" });
  const selectedItem = mode === "recent" ? historyItems[sel] ?? null : null;

  // Load recent Claude sessions on mount
  useEffect(() => {
    asyncState.run("Loading sessions...", async () => {
      const sessions = await core.listClaudeSessions({ limit: RECENT_LIMIT });
      setClaudeSessions(sessions);
    });
  }, []);

  useInput((input, key) => {
    if (pane !== "left") return;

    // Enter — import selected Claude session (orphans only)
    if (key.return && mode === "recent" && selectedItem?.type === "claude" && selectedItem.claudeSession) {
      const cs = selectedItem.claudeSession;
      asyncState.run("Importing session...", () => {
        const s = core.startSession({
          summary: cs.summary?.slice(0, 100) || `Import ${cs.sessionId.slice(0, 8)}`,
          repo: cs.project,
          workdir: cs.project,
          flow: "bare",
        });
        core.updateSession(s.id, { claude_session_id: cs.sessionId });
        status.show(`Imported ${cs.sessionId.slice(0, 8)}`);
        refresh();
      });
      return;
    }

    // / — rebuild FTS5 transcript index
    if (input === "/" && mode !== "search") {
      asyncState.run("Indexing transcripts...", async () => {
        const count = await core.indexTranscripts({
          onProgress: (indexed, files) => {
            status.show(`Indexing... ${files} files, ${indexed} entries`);
          },
        });
        status.show(`Indexed ${count} transcript entries`);
      });
      return;
    }

    // s — toggle search mode
    if (input === "s" && mode !== "search") {
      setMode("search");
      setSearchQuery("");
      setSearchResults([]);
      return;
    }

    // Esc — exit search mode
    if (key.escape && mode === "search") {
      setMode("recent");
      return;
    }

    // r — reload recent
    if (input === "r" && mode !== "search") {
      asyncState.run("Reloading...", async () => {
        const sessions = await core.listClaudeSessions({ limit: RECENT_LIMIT });
        setClaudeSessions(sessions);
        status.show(`Loaded ${sessions.length} recent sessions`);
      });
      return;
    }
  });

  const doSearch = (query: string) => {
    if (!query.trim()) return;
    asyncState.run("Searching...", async () => {
      const dbResults = core.searchSessions(query, { limit: 20 });
      const txResults = core.searchTranscripts(query, { limit: 20 });
      const combined = [...dbResults, ...txResults];
      setSearchResults(combined);
      status.show(`Found ${combined.length} result(s)`);
    });
  };

  const arkCount = arkSessions.length;
  const orphanCount = historyItems.filter(i => i.type === "claude").length;
  const leftTitle = mode === "recent"
    ? `Sessions (${arkCount} ark, ${orphanCount} claude)`
    : `Search Results (${searchResults.length})`;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <SplitPane
        focus={pane}
        leftTitle={leftTitle}
        rightTitle="Details"
        left={
          <Box flexDirection="column">
            {mode === "search" && (
              <Box marginBottom={1}>
                <Text color="cyan">{" search: "}</Text>
                <TextInputEnhanced
                  value={searchQuery}
                  onChange={setSearchQuery}
                  onSubmit={() => doSearch(searchQuery)}
                  placeholder="Type query, Enter to search, Esc to cancel"
                />
              </Box>
            )}
            {asyncState.loading && items.length === 0 ? (
              <Text><Spinner type="dots" /> <Text dimColor>{asyncState.label || "loading..."}</Text></Text>
            ) : mode === "recent" ? (
              historyItems.length === 0 ? (
                <Text dimColor>{"  No sessions found. Press r to reload."}</Text>
              ) : (
                historyItems.map((item, idx) => {
                  const marker = idx === sel ? ">" : " ";
                  const tag = item.type === "ark" ? "ARK" : "   ";
                  const proj = item.project.slice(0, 18).padEnd(18);
                  const summary = item.summary.slice(0, 40);
                  return (
                    <Text key={item.id + idx}>
                      {`${marker} `}
                      <Text color={item.type === "ark" ? "green" : "dim"}>{tag}</Text>
                      {` ${item.date}  ${proj}  ${summary}`}
                    </Text>
                  );
                })
              )
            ) : (
              searchResults.length === 0 ? (
                <Text dimColor>{"  No results. Try a different query."}</Text>
              ) : (
                searchResults.map((r, idx) => {
                  const sourceColor = r.source === "transcript" ? "magenta" : r.source === "message" ? "green" : "cyan";
                  const match = r.match?.slice(0, 60) || "";
                  return (
                    <Text key={`${r.sessionId}-${idx}`}>
                      {`  `}<Text color={sourceColor}>{`[${r.source.slice(0, 4)}]`}</Text>{` ${r.sessionId.slice(0, 8)}  ${match}`}
                    </Text>
                  );
                })
              )
            )}
            {mode === "recent" && (
              <Text dimColor>{"\n  s:search  /:index  r:reload"}</Text>
            )}
          </Box>
        }
        right={
          asyncState.loading && asyncState.label ? (
            <Box flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
              <Text color="yellow"><Spinner type="dots" />{` ${asyncState.label}`}</Text>
            </Box>
          ) : (
            <HistoryDetail item={selectedItem} pane={pane} />
          )
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

// -- Detail ------------------------------------------------------------------

function HistoryDetail({ item, pane }: { item: HistoryItem | null; pane: string }) {
  if (!item) {
    return <Text dimColor>{"  Select a session to view details"}</Text>;
  }

  if (item.type === "ark") {
    const s = item.arkSession;
    return (
      <DetailPanel active={pane === "right"}>
        <SectionHeader title="Ark Session" />
        <KeyValue label="ID">{s.id}</KeyValue>
        <KeyValue label="Status">{s.status}</KeyValue>
        <KeyValue label="Flow">{s.flow}</KeyValue>
        {s.stage && <KeyValue label="Stage">{s.stage}</KeyValue>}
        {s.repo && <KeyValue label="Repo">{s.repo}</KeyValue>}
        <KeyValue label="Age">{ago(s.updated_at || s.created_at)}</KeyValue>
        {s.summary && (
          <>
            <Text> </Text>
            <Text wrap="wrap">{`  ${s.summary}`}</Text>
          </>
        )}
      </DetailPanel>
    );
  }

  const cs = item.claudeSession!;
  return (
    <DetailPanel active={pane === "right"}>
      <SectionHeader title="Claude Session" />
      <KeyValue label="Project">{cs.project}</KeyValue>
      <KeyValue label="Messages">{String(cs.messageCount)}</KeyValue>
      <KeyValue label="Last active">{ago(cs.lastActivity || cs.timestamp)}</KeyValue>

      {cs.summary && (
        <>
          <Text> </Text>
          <Text wrap="wrap">{`  ${cs.summary.slice(0, 300)}`}</Text>
        </>
      )}

      <Text> </Text>
      <Text dimColor>{"  Enter to import into Ark"}</Text>
    </DetailPanel>
  );
}

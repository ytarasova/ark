import React, { useState, useMemo, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { Session, Event, SearchResult } from "../../core/index.js";
import { ICON, getStatusColor } from "../constants.js";
import { hms } from "../helpers.js";
import { formatEvent } from "../helpers/formatEvent.js";
import { formatTokenDisplay, buildFileLinks, buildCommitLinks, stripAnsiAndFilter } from "../helpers/sessionFormatting.js";
import { getSessionCost, formatCost } from "../../core/costs.js";
import { SectionHeader } from "../components/SectionHeader.js";
import { DetailPanel } from "../components/DetailPanel.js";
import { Link } from "../components/Link.js";
import { KeyValue } from "../components/KeyValue.js";
import { TextInputEnhanced } from "../components/TextInputEnhanced.js";
import { useAgentOutput } from "../hooks/useAgentOutput.js";
import { useListNavigation } from "../hooks/useListNavigation.js";
import { useArkClient } from "../hooks/useArkClient.js";

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
}

export function SessionDetail({ session: s, pane, searchMode, searchQuery, searchResults, onSearchToggle, onSearchQueryChange, onSearchSubmit }: SessionDetailProps) {
  const ark = useArkClient();
  const [events, setEvents] = useState<Event[]>([]);
  const [conversation, setConversation] = useState<{ role: string; content: string; timestamp: string }[]>([]);

  useEffect(() => {
    if (!s) { setEvents([]); return; }
    ark.sessionEvents(s.id, 50).then(setEvents).catch(() => setEvents([]));
  }, [s?.id, s?.status]);

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
    return <Box flexGrow={1}><Text dimColor>{"  No session selected."}</Text></Box>;
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
        <Text color={getStatusColor(s.status) as any} bold>
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
      {s.pr_url && (
        <KeyValue label="PR">
          <Link url={s.pr_url} color="cyan">{s.pr_url.replace("https://github.com/", "")}</Link>
        </KeyValue>
      )}

      {/* Token usage */}
      {formatTokenDisplay(s) && (
        <KeyValue label="Tokens">{formatTokenDisplay(s)}</KeyValue>
      )}
      {costInfo && costInfo.cost > 0 && (
        <KeyValue label="Cost">{formatCost(costInfo.cost)}</KeyValue>
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
            const color = turn.role === "user" ? "cyan" : undefined;
            const dim = turn.role !== "user";
            return (
              <Text key={`${turn.role}-${turn.timestamp}-${idx}`} wrap="wrap">
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
          {stripAnsiAndFilter(agentOutput).map((line, idx) => (
            <Text key={`out-${idx}`} wrap="truncate">{`  ${line}`}</Text>
          ))}
        </>
      ) : null}

      {/* Events - visual separator */}
      {events.length > 0 && (
        <>
          <Text> </Text>
          <SectionHeader title="Events" />
          {events.slice(-10).map((ev) => {
            const ts = hms(ev.created_at).slice(0, 5); // HH:MM
            const msg = formatEvent(ev.type, ev.data ?? undefined);
            return (
              <Text key={ev.id}>
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

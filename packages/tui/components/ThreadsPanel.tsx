/**
 * Unified threads panel — like a Slack channel where all agents
 * and the user participate. Shows messages from all sessions in
 * chronological order. User can reply with @session-name to target
 * a specific agent.
 *
 * Messages are stored in the messages table and persist across restarts.
 */

import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";
import type { Session } from "../../core/index.js";
import { roleColor } from "../helpers/colors.js";
import { TextInputEnhanced } from "./TextInputEnhanced.js";
import { ScrollBox } from "./ScrollBox.js";
import { useMessages } from "../hooks/useMessages.js";

interface ThreadsPanelProps {
  sessions: Session[];
  onDone: () => void;
}

/** Extract the @mention being typed (if any) from text that starts with @ */
export function extractMentionPrefix(text: string): string | null {
  const match = text.match(/^@(\S*)$/);
  return match ? match[1] : null;
}

/** Filter sessions matching a prefix (case-insensitive, matches name or id) */
export function filterSessionCompletions(
  sessions: Session[],
  prefix: string,
): { label: string; id: string }[] {
  const lower = prefix.toLowerCase();
  const results: { label: string; id: string }[] = [];
  for (const s of sessions) {
    const name = s.summary ?? s.id;
    if (name.toLowerCase().startsWith(lower) || s.id.toLowerCase().startsWith(lower)) {
      results.push({ label: name, id: s.id });
    }
  }
  return results;
}

/**
 * Parse @mention from message text and resolve target session.
 * Returns { targetId, content } where targetId is null if no target found.
 */
export function parseMentions(
  text: string,
  sessionMap: Map<string, string>,
  sessions: Session[],
): { targetId: string | null; content: string } {
  const atMatch = text.match(/^@(\S+)\s+([\s\S]+)$/);
  let targetId: string | null = null;
  let content = text;

  if (atMatch) {
    const tag = atMatch[1].toLowerCase();
    targetId = sessionMap.get(tag) ?? null;
    if (targetId) {
      content = atMatch[2];
    }
  }

  if (!targetId) {
    // No valid @tag -- try to find a single running/waiting session
    const active = sessions.filter(s => s.status === "running" || s.status === "waiting");
    if (active.length === 1) {
      targetId = active[0].id;
    }
  }

  return { targetId, content };
}

export function ThreadsPanel({ sessions, onDone }: ThreadsPanelProps) {
  const theme = getTheme();
  const [msg, setMsg] = useState("");
  const [completionIndex, setCompletionIndex] = useState(0);

  const { messages: allMessages, send: sendMessage } = useMessages({
    sessions,
    pollMs: 2000,
    limit: 30,
  });

  // Build a name→id lookup
  const sessionMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sessions) {
      const name = s.summary ?? s.id;
      m.set(name.toLowerCase(), s.id);
      m.set(s.id, s.id);
    }
    return m;
  }, [sessions]);

  // Compute autocomplete candidates
  const mentionPrefix = extractMentionPrefix(msg);
  const completions = useMemo(() => {
    if (mentionPrefix === null) return [];
    return filterSessionCompletions(sessions, mentionPrefix);
  }, [sessions, mentionPrefix]);

  const showCompletions = completions.length > 0;

  // Reset completion index when candidates change
  useEffect(() => {
    setCompletionIndex(0);
  }, [completions.length, mentionPrefix]);

  const [scrollMode, setScrollMode] = useState(false);
  const inputFocused = !scrollMode;

  useInput((input, key) => {
    if (key.tab && !showCompletions) { setScrollMode(s => !s); return; }
    if (key.escape) { onDone(); }
  });

  const handleTab = useCallback(() => {
    if (!showCompletions) return;
    const selected = completions[completionIndex];
    if (selected) {
      setMsg(`@${selected.label} `);
    }
  }, [showCompletions, completions, completionIndex]);

  const handleUpArrow = useCallback(() => {
    if (!showCompletions) return;
    setCompletionIndex(i => (i <= 0 ? completions.length - 1 : i - 1));
  }, [showCompletions, completions.length]);

  const handleDownArrow = useCallback(() => {
    if (!showCompletions) return;
    setCompletionIndex(i => (i >= completions.length - 1 ? 0 : i + 1));
  }, [showCompletions, completions.length]);

  const send = () => {
    const text = msg.trim();
    if (!text) return;

    const { targetId, content } = parseMentions(text, sessionMap, sessions);
    if (!targetId) {
      // Can't determine target
      setMsg("");
      return;
    }

    sendMessage(targetId, content);
    setMsg("");
  };

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color={theme.accent}>{" Threads "}</Text>
      <Text> </Text>

      {/* Message stream — j/k/g/G scroll when focused, auto-follow when input focused */}
      {allMessages.length === 0 ? (
        <Box flexGrow={1}><Text dimColor>{"  No messages yet. Agents will post here."}</Text></Box>
      ) : (
        <ScrollBox
          active={scrollMode}
          followIndex={inputFocused ? allMessages.length - 1 : undefined}
         
        >
          {allMessages.map((m) => {
            const isUser = m.role === "user";
            const msgColor = roleColor(m.role);
            const sender = isUser ? "you" : m.sessionName;
            const typeTag = m.type !== "text" ? ` [${m.type}]` : "";
            const prefix = isUser && m.session_id ? ` \u2192${(sessions.find(s => s.id === m.session_id)?.summary ?? m.session_id).slice(0, 15)}` : "";
            return (
              <Text key={m.id} wrap="wrap">
                <Text dimColor>{`${m.time} `}</Text>
                <Text color={msgColor} bold>{sender}</Text>
                {prefix && <Text dimColor>{` ${prefix}`}</Text>}
                {typeTag && <Text dimColor>{typeTag}</Text>}
                <Text>{` ${m.content}`}</Text>
              </Text>
            );
          })}
        </ScrollBox>
      )}

      {/* Autocomplete dropdown */}
      {showCompletions && (
        <Box flexDirection="column" marginLeft={2}>
          {completions.slice(0, 8).map((c, i) => (
            <Text key={c.id}>
              <Text color={i === completionIndex ? theme.accent : undefined} bold={i === completionIndex}>
                {i === completionIndex ? "❯ " : "  "}
              </Text>
              <Text color={i === completionIndex ? theme.accent : "white"} bold={i === completionIndex}>
                {c.label}
              </Text>
              <Text dimColor>{` (${c.id})`}</Text>
            </Text>
          ))}
        </Box>
      )}

      {/* Input panel */}
      <Box borderStyle="single" borderColor={inputFocused ? theme.accent : "gray"} paddingX={1} width="100%" flexShrink={0}>
        <Text color={inputFocused ? theme.accent : "gray"}>{"> "}</Text>
        <TextInputEnhanced
          value={msg}
          onChange={setMsg}
          onSubmit={send}
          onTab={showCompletions ? handleTab : undefined}
          onUpArrow={showCompletions ? handleUpArrow : undefined}
          onDownArrow={showCompletions ? handleDownArrow : undefined}
          focus={inputFocused}
          placeholder="@session-name message..."
        />
      </Box>
    </Box>
  );
}

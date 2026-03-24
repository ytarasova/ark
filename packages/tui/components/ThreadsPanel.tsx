/**
 * Unified threads panel — like a Slack channel where all agents
 * and the user participate. Shows messages from all sessions in
 * chronological order. User can reply with @session-name to target
 * a specific agent.
 *
 * Messages are stored in the messages table and persist across restarts.
 */

import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import * as core from "../../core/index.js";
import { TextInputEnhanced } from "./TextInputEnhanced.js";

interface ThreadsPanelProps {
  sessions: core.Session[];
  onDone: () => void;
}

interface ThreadMessage {
  id: number;
  sessionName: string;
  sessionId: string;
  role: string;
  content: string;
  type: string;
  time: string;
}

export function ThreadsPanel({ sessions, onDone }: ThreadsPanelProps) {
  const [msg, setMsg] = useState("");
  const [allMessages, setAllMessages] = useState<ThreadMessage[]>([]);

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

  // Load all messages across all sessions
  useEffect(() => {
    const load = () => {
      const all: ThreadMessage[] = [];
      for (const s of sessions) {
        const msgs = core.getMessages(s.id, { limit: 10 });
        const name = s.summary ?? s.id;
        for (const m of msgs) {
          all.push({
            id: m.id,
            sessionName: name,
            sessionId: s.id,
            role: m.role,
            content: m.content,
            type: m.type,
            time: m.created_at.slice(11, 16),
          });
        }
      }
      // Sort by ID (chronological across all sessions)
      all.sort((a, b) => a.id - b.id);
      setAllMessages(all);

      // Mark all as read
      for (const s of sessions) {
        core.markMessagesRead(s.id);
      }
    };
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [sessions]);

  useInput((input, key) => {
    if (key.escape) onDone();
  });

  const send = async () => {
    const text = msg.trim();
    if (!text) return;

    // Parse @session-name prefix
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
      // No valid @tag — try to find a single running/waiting session
      const active = sessions.filter(s => s.status === "running" || s.status === "waiting");
      if (active.length === 1) {
        targetId = active[0].id;
      } else {
        // Can't determine target
        setMsg("");
        return;
      }
    }

    // Store and send
    core.addMessage({ session_id: targetId, role: "user", content });
    setMsg("");

    const channelPort = core.sessionChannelPort(targetId);
    try {
      await fetch(`http://localhost:${channelPort}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "steer",
          sessionId: targetId,
          message: content,
          from: "user",
        }),
      });
    } catch {
      core.addMessage({ session_id: targetId, role: "system", content: "Failed to deliver", type: "error" });
    }
  };

  // Display
  const visible = allMessages.slice(-30);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color="cyan">{" Threads "}</Text>
      <Text> </Text>

      {/* Message stream */}
      <Box flexDirection="column" flexGrow={1}>
        {visible.length === 0 && (
          <Text dimColor>{"  No messages yet. Agents will post here."}</Text>
        )}
        {visible.map((m) => {
          const isUser = m.role === "user";
          const isSystem = m.role === "system";
          const roleColor = isUser ? "cyan" : isSystem ? "gray" : "green";
          const sender = isUser ? "you" : m.sessionName;
          const typeTag = m.type !== "text" ? ` [${m.type}]` : "";
          const prefix = isUser && m.sessionId ? `→${(sessions.find(s => s.id === m.sessionId)?.summary ?? m.sessionId).slice(0, 12)}` : "";
          return (
            <Text key={m.id} wrap="wrap">
              <Text dimColor>{`${m.time} `}</Text>
              <Text color={roleColor as any} bold>{sender}</Text>
              {prefix && <Text dimColor>{` ${prefix}`}</Text>}
              {typeTag && <Text dimColor>{typeTag}</Text>}
              <Text>{` ${m.content}`}</Text>
            </Text>
          );
        })}
      </Box>

      {/* Input */}
      <Box>
        <Text color="cyan">{"> "}</Text>
        <TextInputEnhanced
          value={msg}
          onChange={setMsg}
          onSubmit={send}
          focus={true}
          placeholder="@session-name message..."
        />
      </Box>
      <Text dimColor>{"  @name:target agent  Enter:send  Esc:back"}</Text>
    </Box>
  );
}

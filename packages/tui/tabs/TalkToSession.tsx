import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";
import type { Session } from "../../core/index.js";
import { roleColor } from "../helpers/colors.js";
import { ScrollBox } from "../components/ScrollBox.js";
import { TextInputEnhanced } from "../components/TextInputEnhanced.js";
import { useMessages } from "../hooks/useMessages.js";
import type { AsyncState } from "../hooks/useAsync.js";

export interface TalkToSessionProps {
  session: Session | null;
  asyncState: AsyncState;
  onDone: (message?: string) => void;
}

export function TalkToSession({ session, asyncState, onDone }: TalkToSessionProps) {
  const theme = getTheme();
  const [msg, setMsg] = useState("");
  const [scrollMode, setScrollMode] = useState(false);

  const { messages, send: sendMessage } = useMessages({
    sessionId: session?.id,
    pollMs: 2000,
    limit: 20,
    asyncState,
  });

  useInput((input, key) => {
    if (key.escape) onDone();
  });

  if (!session) {
    onDone();
    return null;
  }

  const send = () => {
    if (!msg.trim()) return;
    sendMessage(session.id, msg.trim());
    setMsg("");
  };

  // Tab toggles focus: messages (scroll with j/k) vs input (type)
  const inputFocused = !scrollMode;

  useInput((input, key) => {
    if (key.tab) { setScrollMode(s => !s); return; }
    if (key.escape) { onDone(null); }
  });

  const messageElements = messages.map((m) => {
    const color = roleColor(m.role);
    const typeTag = m.type !== "text" ? ` [${m.type}]` : "";
    return (
      <Text key={m.id} wrap="wrap">
        <Text dimColor>{`  ${m.time} `}</Text>
        <Text color={color} bold>{m.role === "user" ? "you" : (session?.agent || "agent")}</Text>
        {typeTag && <Text dimColor>{typeTag}</Text>}
        <Text>{` ${m.content}`}</Text>
      </Text>
    );
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color={theme.accent}>{` Chat: ${session.summary ?? session.id} `}</Text>
      <Text> </Text>

      {/* Messages — j/k/g/G scroll when focused, auto-follow when input focused */}
      {messages.length === 0 ? (
        <Box flexGrow={1}><Text dimColor>{"  No messages yet. Type below to send."}</Text></Box>
      ) : (
        <ScrollBox
          active={scrollMode}
          followIndex={inputFocused ? messageElements.length - 1 : undefined}
         
        >
          {messageElements}
        </ScrollBox>
      )}

      {/* Input panel */}
      <Box borderStyle="single" borderColor={inputFocused ? theme.accent : "gray"} paddingX={1} width="100%" flexShrink={0}>
        <Text color={inputFocused ? theme.accent : "gray"}>{"> "}</Text>
        <TextInputEnhanced
          value={msg}
          onChange={setMsg}
          onSubmit={send}
          focus={inputFocused}
          placeholder="Type a message..."
        />
      </Box>
    </Box>
  );
}

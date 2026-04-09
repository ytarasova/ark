import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";
import type { Session } from "../../core/index.js";

interface SessionSearchProps {
  sessions: Session[];
  onSelect: (session: Session) => void;
  onClose: () => void;
}

function fuzzyMatch(text: string, query: string): boolean {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

export function SessionSearch({ sessions, onSelect, onClose }: SessionSearchProps) {
  const theme = getTheme();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const results = useMemo(() => {
    if (!query) return sessions.slice(0, 10);
    return sessions.filter(s => {
      const text = [s.summary, s.ticket, s.repo, s.id].filter(Boolean).join(" ");
      return fuzzyMatch(text, query);
    }).slice(0, 10);
  }, [sessions, query]);

  useInput((input, key) => {
    if (key.escape) { onClose(); return; }
    if (key.return) {
      if (results[cursor]) onSelect(results[cursor]);
      onClose();
      return;
    }
    if (key.downArrow || (input === "j" && key.ctrl)) {
      setCursor(c => Math.min(c + 1, results.length - 1));
      return;
    }
    if (key.upArrow || (input === "k" && key.ctrl)) {
      setCursor(c => Math.max(c - 1, 0));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery(q => q.slice(0, -1));
      setCursor(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery(q => q + input);
      setCursor(0);
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.accent} bold>/ </Text>
        <Text>{query}</Text>
        <Text color="gray">█</Text>
      </Box>
      {results.map((s, i) => (
        <Box key={s.id}>
          <Text color={i === cursor ? theme.accent : undefined} bold={i === cursor}>
            {i === cursor ? ">" : " "} {s.summary ?? s.id}
          </Text>
          <Text color="gray"> ({s.status})</Text>
        </Box>
      ))}
      {results.length === 0 && <Text color="gray">  No matches</Text>}
    </Box>
  );
}

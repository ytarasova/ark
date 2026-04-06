import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { useArkClient } from "../hooks/useArkClient.js";
import type { AsyncState } from "../hooks/useAsync.js";

interface MemoryManagerProps {
  asyncState?: AsyncState;
  onClose: () => void;
}

export function MemoryManager({ onClose }: MemoryManagerProps) {
  const ark = useArkClient();
  const [memories, setMemories] = useState<any[]>([]);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    ark.memoryList().then(list => {
      setMemories(list);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useInput((input, key) => {
    if (key.escape) { onClose(); return; }
    if (input === "j" || key.downArrow) setCursor(c => Math.min(c + 1, memories.length - 1));
    if (input === "k" || key.upArrow) setCursor(c => Math.max(c - 1, 0));
    if (input === "d" && memories[cursor]) {
      const id = memories[cursor].id;
      ark.memoryForget(id).then(() => {
        setMemories(prev => prev.filter(m => m.id !== id));
        setCursor(c => Math.min(c, memories.length - 2));
      });
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Memories</Text>
      <Text dimColor>j/k: navigate  d: delete  Esc: close</Text>
      <Box flexDirection="column" marginTop={1}>
        {loading && <Text dimColor>Loading...</Text>}
        {!loading && memories.length === 0 && <Text dimColor>No memories stored</Text>}
        {memories.map((m, i) => (
          <Text key={m.id} inverse={i === cursor}>
            {` ${m.content.slice(0, 60)}${m.content.length > 60 ? "..." : ""} `}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

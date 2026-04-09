import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";
import type { Session } from "../../core/index.js";
import { SelectMenu } from "../components/SelectMenu.js";
import { TextInputEnhanced } from "../components/TextInputEnhanced.js";
import { useArkClient } from "../hooks/useArkClient.js";

export interface MoveToGroupProps {
  session: Session | null;
  onDone: (group: string | undefined) => void;
}

export function MoveToGroup({ session, onDone }: MoveToGroupProps) {
  const theme = getTheme();
  const ark = useArkClient();
  const [newGroup, setNewGroup] = useState("");
  const [mode, setMode] = useState<"pick" | "new">("pick");
  const [existing, setExisting] = useState<string[]>([]);
  useEffect(() => { ark.groupList().then((groups: any[]) => setExisting(groups.map((g: any) => g.name ?? g))); }, []);

  useInput((input, key) => {
    if (key.escape) onDone(undefined);
  });

  const choices = [
    ...existing.map(g => ({ label: g, value: g })),
    { label: "(none) - remove from group", value: "__none__" },
    { label: "+ New group...", value: "__new__" },
  ];

  if (mode === "new") {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text bold color={theme.accent}>{" Move to Group "}</Text>
        <Text> </Text>
        <Text>{`Session: ${session?.summary ?? session?.id}`}</Text>
        <Text> </Text>
        <Text>{"New group name:"}</Text>
        <Box>
          <Text color={theme.accent}>{"> "}</Text>
          <TextInputEnhanced
            value={newGroup}
            onChange={setNewGroup}
            onSubmit={() => { if (newGroup.trim()) { onDone(newGroup.trim()); } }}
            placeholder="Enter group name..."
          />
        </Box>
        <Box flexGrow={1} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color={theme.accent}>{" Move to Group "}</Text>
      <Text> </Text>
      <Text>{`Session: ${session?.summary ?? session?.id}`}</Text>
      <Text> </Text>
      <SelectMenu
        items={choices}
        onSelect={(item) => {
          if (item.value === "__new__") {
            setMode("new");
          } else if (item.value === "__none__") {
            onDone("");
          } else {
            onDone(item.value);
          }
        }}
      />
      <Box flexGrow={1} />
    </Box>
  );
}

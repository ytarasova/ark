import React, { useState, useMemo, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { Session } from "../../core/index.js";
import { SelectMenu } from "../components/SelectMenu.js";
import { TextInputEnhanced } from "../components/TextInputEnhanced.js";
import { useGroupActions } from "../hooks/useGroupActions.js";
import { useArkClient } from "../hooks/useArkClient.js";
import type { AsyncState } from "../hooks/useAsync.js";

export interface GroupManagerProps {
  sessions: Session[];
  asyncState: AsyncState;
  onDone: (message?: string) => void;
}

export function GroupManager({ sessions, asyncState, onDone }: GroupManagerProps) {
  const ark = useArkClient();
  const [action, setAction] = useState<"menu" | "create" | "delete">("menu");
  const [newName, setNewName] = useState("");
  const [existing, setExisting] = useState<string[]>([]);
  useEffect(() => { ark.groupList().then((groups: any[]) => setExisting(groups.map((g: any) => g.name ?? g))); }, []);
  const groupActs = useGroupActions(asyncState);

  useInput((input, key) => {
    if (key.escape) {
      if (action !== "menu") { setAction("menu"); return; }
      onDone();
    }
  });

  if (action === "create") {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text bold color="cyan">{" Create Group "}</Text>
        <Text> </Text>
        <Text>{"Group name:"}</Text>
        <Box>
          <Text color="cyan">{"> "}</Text>
          <TextInputEnhanced
            value={newName}
            onChange={setNewName}
            onSubmit={() => {
              if (!newName.trim()) return;
              groupActs.createGroup(newName.trim(), () => {
                onDone(`Group '${newName.trim()}' created`);
              });
            }}
            placeholder="Enter group name..."
          />
        </Box>
        <Box flexGrow={1} />
      </Box>
    );
  }

  if (action === "delete") {
    const deleteChoices = existing.map(g => {
      const count = sessions.filter(s => s.group_name === g).length;
      return { label: `${g} (${count} session${count !== 1 ? "s" : ""})`, value: g };
    });

    if (deleteChoices.length === 0) {
      return (
        <Box flexDirection="column" flexGrow={1}>
          <Text bold color="cyan">{" Delete Group "}</Text>
          <Text> </Text>
          <Text dimColor>{"  No groups to delete."}</Text>
          <Box flexGrow={1} />
        </Box>
      );
    }

    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text bold color="red">{" Delete Group "}</Text>
        <Text> </Text>
        <Text>{"Select group to delete:"}</Text>
        <SelectMenu
          items={deleteChoices}
          onSelect={(item) => {
            groupActs.deleteGroup(item.value, sessions, (count) => {
              onDone(`Deleted group '${item.value}' (${count} sessions removed)`);
            });
          }}
        />
        <Box flexGrow={1} />
      </Box>
    );
  }

  // Menu
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color="cyan">{" Groups "}</Text>
      <Text> </Text>
      <SelectMenu
        items={[
          { label: "Create new group", value: "create" },
          { label: "Delete group", value: "delete" },
        ]}
        onSelect={(item) => setAction(item.value as "create" | "delete")}
      />
      {existing.length > 0 && (
        <>
          <Text> </Text>
          <Text dimColor>{"  Existing groups:"}</Text>
          {existing.map(g => {
            const count = sessions.filter(s => s.group_name === g).length;
            return <Text key={g} dimColor>{`    ${g} (${count})`}</Text>;
          })}
        </>
      )}
      <Text> </Text>
      <Box flexGrow={1} />
    </Box>
  );
}

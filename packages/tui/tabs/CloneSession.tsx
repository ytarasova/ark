import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import * as core from "../../core/index.js";
import { TextInputEnhanced } from "../components/TextInputEnhanced.js";

export interface CloneSessionProps {
  session: core.Session | null;
  onDone: (name: string | null) => void;
}

export function CloneSession({ session, onDone }: CloneSessionProps) {
  const [name, setName] = useState(session ? `${session.summary ?? session.id}-fork` : "");

  useInput((input, key) => {
    if (key.escape) onDone(null);
  });

  if (!session) { onDone(null); return null; }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color="cyan">{" Fork Session "}</Text>
      <Text> </Text>
      <Text dimColor>{`  Forking: ${session.summary ?? session.id}`}</Text>
      <Text dimColor>{`  Repo: ${session.repo}`}</Text>
      <Text dimColor>{`  Claude conversation will be resumed`}</Text>
      <Text> </Text>
      <Text>{"  New session name:"}</Text>
      <Box>
        <Text color="cyan">{"> "}</Text>
        <TextInputEnhanced
          value={name}
          onChange={setName}
          onSubmit={() => { if (name.trim()) onDone(name.trim()); }}
          focus={true}
        />
      </Box>
      <Box flexGrow={1} />
    </Box>
  );
}

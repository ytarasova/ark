import React, { useState, useMemo, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { useArkClient } from "../hooks/useArkClient.js";
import type { AsyncState } from "../hooks/useAsync.js";

interface SkillsManagerProps {
  session: { id: string; workdir?: string | null; config: Record<string, unknown> };
  asyncState?: AsyncState;
  onClose: () => void;
}

export function SkillsManager({ session, asyncState, onClose }: SkillsManagerProps) {
  const ark = useArkClient();
  const [allSkills, setAllSkills] = useState<any[]>([]);
  useEffect(() => { ark.skillList().then(setAllSkills); }, []);
  const attached = useMemo(() => {
    const cfg = session.config as any;
    return (cfg?.skills as string[]) ?? [];
  }, [session]);

  const [toggleState, setToggleState] = useState<Map<string, boolean>>(() => {
    const state = new Map<string, boolean>();
    for (const s of allSkills) {
      state.set(s.name, attached.includes(s.name));
    }
    return state;
  });

  const skillNames = useMemo(() => allSkills.map(s => s.name), [allSkills]);
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.escape) { onClose(); return; }
    if (input === "j" || key.downArrow) setCursor(c => Math.min(c + 1, skillNames.length - 1));
    if (input === "k" || key.upArrow) setCursor(c => Math.max(c - 1, 0));
    if (input === " ") {
      const name = skillNames[cursor];
      setToggleState(prev => { const next = new Map(prev); next.set(name, !next.get(name)); return next; });
    }
    if (key.return) {
      const sel = skillNames.filter(n => toggleState.get(n));
      if (asyncState) {
        asyncState.run("Updating skills...", async () => {
          await ark.sessionUpdate(session.id, { config: { ...session.config, skills: sel } });
        });
      } else {
        ark.sessionUpdate(session.id, { config: { ...session.config, skills: sel } });
      }
      onClose();
    }
  });

  if (allSkills.length === 0) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
        <Text bold color="magenta">Skills Manager</Text>
        <Text dimColor>No skills found. Create skills in ~/.ark/skills/ or skills/</Text>
        <Text dimColor>Esc to close</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="magenta">Skills Manager</Text>
      </Box>
      {skillNames.map((name, i) => {
        const enabled = toggleState.get(name) ?? false;
        const skill = allSkills.find(s => s.name === name);
        const isCursor = i === cursor;
        return (
          <Box key={name}>
            <Text color={isCursor ? "magenta" : undefined} bold={isCursor}>
              {isCursor ? ">" : " "} {enabled ? "[x]" : "[ ]"} {name}
            </Text>
            {skill?.description && <Text color="gray"> — {skill.description.slice(0, 50)}</Text>}
          </Box>
        );
      })}
      <Box marginTop={1}><Text color="gray">Space:toggle  Enter:apply  Esc:cancel</Text></Box>
    </Box>
  );
}

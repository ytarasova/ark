import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { getThemeMode, getActiveProfile, setThemeMode } from "../../core/index.js";

interface SettingsPanelProps {
  onClose: () => void;
}

export function SettingsPanel({ onClose }: SettingsPanelProps) {
  const theme = getThemeMode();
  const profile = getActiveProfile();
  const [cursor, setCursor] = useState(0);

  const settings = [
    { key: "theme", label: "Theme", value: theme, options: ["dark", "light", "system"] },
    { key: "profile", label: "Profile", value: profile },
  ];

  useInput((input, key) => {
    if (key.escape) { onClose(); return; }
    if (input === "j" || key.downArrow) setCursor(c => Math.min(c + 1, settings.length - 1));
    if (input === "k" || key.upArrow) setCursor(c => Math.max(c - 1, 0));
    if (key.return) {
      const s = settings[cursor];
      if (s.key === "theme" && s.options) {
        const idx = s.options.indexOf(s.value);
        const next = s.options[(idx + 1) % s.options.length];
        setThemeMode(next as import("../../core/theme.js").ThemeMode);
      }
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Box marginBottom={1}><Text bold color="yellow">Settings</Text></Box>
      {settings.map((s, i) => (
        <Box key={s.key}>
          <Text color={i === cursor ? "yellow" : undefined} bold={i === cursor}>
            {i === cursor ? ">" : " "} {s.label}: {s.value}
          </Text>
          {s.options && <Text color="gray"> (Enter to cycle)</Text>}
        </Box>
      ))}
      <Box marginTop={1}><Text color="gray">Enter:toggle  Esc:close</Text></Box>
    </Box>
  );
}

import React from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";

interface HelpOverlayProps {
  onClose: () => void;
}

interface ShortcutGroup {
  title: string;
  items: [string, string][];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: "Session Actions",
    items: [
      ["Enter", "Dispatch/restart"],
      ["s", "Stop"],
      ["I", "Interrupt agent"],
      ["d", "Complete (press twice)"],
      ["t", "Send message"],
      ["f", "Fork session"],
      ["a", "Attach to tmux"],
      ["W", "Worktree finish/PR"],
      ["V", "Run verification"],
      ["Z", "Archive/restore"],
      ["x", "Delete (Ctrl+Z undo)"],
    ],
  },
  {
    title: "Navigation",
    items: [
      ["j/k", "Move up/down"],
      ["Tab", "Toggle panes"],
      ["/", "Search sessions"],
      ["?", "This help"],
      ["1-8", "Switch tabs"],
      ["q", "Quit"],
    ],
  },
  {
    title: "Tools",
    items: [
      ["n", "New session"],
      ["m", "Move to group"],
      ["o", "Group manager"],
      ["r", "Session replay"],
      ["M", "MCP Manager"],
      ["K", "Skills Manager"],
      ["P", "Settings"],
      ["e", "Expand events"],
    ],
  },
  {
    title: "Filters",
    items: [
      ["!", "Running"],
      ["@", "Waiting"],
      ["#", "Stopped"],
      ["$", "Failed"],
      ["0", "Clear filter"],
    ],
  },
];

export function HelpOverlay({ onClose }: HelpOverlayProps) {
  const theme = getTheme();
  useInput((input, key) => {
    if (key.escape || input === "?") onClose();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="white" paddingX={2} paddingY={1}>
      <Box marginBottom={1}><Text bold>Keyboard Shortcuts</Text></Box>
      {GROUPS.map((group, gi) => (
        <Box key={group.title} flexDirection="column" marginBottom={gi < GROUPS.length - 1 ? 1 : 0}>
          <Text bold color={theme.accent}>{group.title}</Text>
          {group.items.map(([shortcut, desc]) => (
            <Box key={shortcut}>
              <Text color={theme.accent} bold>{"  "}{shortcut.padEnd(10)}</Text>
              <Text>{desc}</Text>
            </Box>
          ))}
        </Box>
      ))}
      <Box marginTop={1}><Text color="gray">Press ? or Esc to close</Text></Box>
    </Box>
  );
}

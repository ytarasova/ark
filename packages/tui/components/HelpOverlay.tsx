import React from "react";
import { Box, Text, useInput } from "ink";

interface HelpOverlayProps {
  onClose: () => void;
}

const SHORTCUTS: [string, string][] = [
  ["j/k", "Navigate up/down"],
  ["f/b", "Page up/down"],
  ["g/G", "Top/bottom"],
  ["Enter", "Dispatch/restart"],
  ["s", "Stop session"],
  ["r", "Session replay"],
  ["f", "Fork session"],
  ["a", "Attach to tmux"],
  ["t", "Talk (send message)"],
  ["x", "Delete (press twice)"],
  ["d", "Mark done (press twice)"],
  ["u", "Mark as waiting"],
  ["m", "Move to group"],
  ["M", "MCP Manager"],
  ["K", "Skills Manager"],
  ["P", "Settings"],
  ["i", "Import hint"],
  ["Ctrl+Z", "Undo delete"],
  ["/", "Search sessions"],
  ["!/@/#/$", "Filter by status"],
  ["0", "Clear filter"],
  ["n", "New session"],
  ["o", "Group manager"],
  ["e", "Expand events"],
  ["Tab", "Toggle pane"],
  ["1-7", "Switch tabs"],
  ["?", "This help"],
  ["q", "Quit"],
];

export function HelpOverlay({ onClose }: HelpOverlayProps) {
  useInput((input, key) => {
    if (key.escape || input === "?") onClose();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="white" paddingX={2} paddingY={1}>
      <Box marginBottom={1}><Text bold>Keyboard Shortcuts</Text></Box>
      {SHORTCUTS.map(([shortcut, desc]) => (
        <Box key={shortcut}>
          <Text color="cyan" bold>{shortcut.padEnd(12)}</Text>
          <Text>{desc}</Text>
        </Box>
      ))}
      <Box marginTop={1}><Text color="gray">Press ? or Esc to close</Text></Box>
    </Box>
  );
}

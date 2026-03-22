import React from "react";
import { Box } from "ink";

interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
}

export function SplitPane({ left, right }: SplitPaneProps) {
  return (
    <Box flexGrow={1}>
      <Box flexDirection="column" width="40%" borderStyle="single" borderColor="gray" paddingX={1}>
        {left}
      </Box>
      <Box flexDirection="column" width="60%" borderStyle="single" borderColor="gray" paddingX={1}>
        {right}
      </Box>
    </Box>
  );
}

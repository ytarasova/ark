import React from "react";
import { Box, Text } from "ink";
import { getTheme } from "../../core/theme.js";

type Pane = "left" | "right";

interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
  leftTitle?: string;
  rightTitle?: string;
  leftWidth?: string;
  focus?: Pane;
}

export function SplitPane({ left, right, leftTitle, rightTitle, leftWidth = "30%", focus = "left" }: SplitPaneProps) {
  const theme = getTheme();
  const rightWidth = `${100 - parseInt(leftWidth)}%`;
  return (
    <Box flexGrow={1}>
      <Box flexDirection="column" width={leftWidth}
        borderStyle="single"
        borderColor={focus === "left" ? theme.accent : "gray"}
        paddingX={1}>
        {leftTitle && (
          <>
            <Text color={focus === "left" ? theme.accent : "white"} bold={focus === "left"}>
              {` ${leftTitle} `}
            </Text>
            <Text> </Text>
          </>
        )}
        <Box flexDirection="column" overflow="hidden" flexGrow={1}>
          {left}
        </Box>
      </Box>
      <Box flexDirection="column" width={rightWidth}
        borderStyle="single"
        borderColor={focus === "right" ? theme.accent : "gray"}
        paddingLeft={1} paddingRight={2}>
        {rightTitle && (
          <>
            <Text color={focus === "right" ? theme.accent : "white"} bold={focus === "right"}>
              {` ${rightTitle} `}
            </Text>
            <Text> </Text>
          </>
        )}
        <Box flexDirection="column" overflow="hidden" flexGrow={1}>
          {right}
        </Box>
      </Box>
    </Box>
  );
}

export type { Pane };

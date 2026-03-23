import React from "react";
import { Box, Text } from "ink";

type Pane = "left" | "right";

interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
  leftTitle?: string;
  rightTitle?: string;
  focus?: Pane;
}

export function SplitPane({ left, right, leftTitle, rightTitle, focus = "left" }: SplitPaneProps) {
  return (
    <Box flexGrow={1}>
      <Box flexDirection="column" width="40%"
        borderStyle="single"
        borderColor={focus === "left" ? "cyan" : "gray"}
        paddingX={1}>
        {leftTitle && (
          <>
            <Text color={focus === "left" ? "cyan" : "white"} bold={focus === "left"}>
              {` ${leftTitle} `}
            </Text>
            <Text> </Text>
          </>
        )}
        <Box flexDirection="column" overflow="hidden" flexGrow={1}>
          {left}
        </Box>
      </Box>
      <Box flexDirection="column" width="60%"
        borderStyle="single"
        borderColor={focus === "right" ? "cyan" : "gray"}
        paddingX={1}>
        {rightTitle && (
          <>
            <Text color={focus === "right" ? "cyan" : "white"} bold={focus === "right"}>
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

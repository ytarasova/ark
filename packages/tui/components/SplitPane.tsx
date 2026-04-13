import React from "react";
import { Box, Text, useStdout } from "ink";
import { getTheme } from "../../core/theme.js";
import { AvailableHeightContext } from "./ScrollBox.js";

type Pane = "left" | "right";

interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
  leftTitle?: string;
  rightTitle?: string;
  leftWidth?: string;
  focus?: Pane;
  /** Rows consumed by elements outside this SplitPane (tab bar, events, status bar). */
  outerChrome?: number;
}

export function SplitPane({ left, right, leftTitle, rightTitle, leftWidth = "30%", focus = "left", outerChrome = 5 }: SplitPaneProps) {
  const theme = getTheme();
  const rightWidth = `${100 - parseInt(leftWidth)}%`;
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 40;

  // SplitPane's own chrome: border top (1) + title (1) + spacer (1) + border bottom (1) = 4
  const splitPaneChrome = leftTitle ? 4 : 2;
  const contentHeight = Math.max(5, termRows - outerChrome - splitPaneChrome);

  return (
    <AvailableHeightContext.Provider value={contentHeight}>
      <Box flexGrow={1}>
        <Box flexDirection="column" width={leftWidth}
          borderStyle="single"
          borderColor={focus === "left" ? theme.accent : theme.dimText}
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
          borderColor={focus === "right" ? theme.accent : theme.dimText}
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
    </AvailableHeightContext.Provider>
  );
}

export type { Pane };

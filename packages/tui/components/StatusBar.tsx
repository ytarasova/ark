import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { getTheme } from "../../core/theme.js";
import type { Tab } from "./TabBar.js";
import type { Session } from "../../core/index.js";
import {
  getOverlayHints,
  getRightPaneHints,
  getSessionHints,
  getAgentsHints,
  getToolsHints,
  getFlowsHints,
  getComputeHints,
  getHistoryHints,
  getCostsHints,
  getGenericHints,
} from "../helpers/statusBarHints.js";

interface StatusBarProps {
  tab: Tab;
  sessions: Session[];
  selectedSession?: Session | null;
  loading: boolean;
  error: string | null;
  label: string | null;
  pane?: "left" | "right";
  overlay?: string | null;
}

export function StatusBar({ tab, sessions, selectedSession, loading, error, label, pane, overlay }: StatusBarProps) {
  const theme = getTheme();
  const nRun = sessions.filter((s) => s.status === "running").length;
  const nErr = sessions.filter((s) => s.status === "failed").length;

  const hints = useMemo(() =>
    overlay ? getOverlayHints(overlay)
    : pane === "right" ? getRightPaneHints(tab)
    : tab === "sessions" ? getSessionHints(selectedSession)
    : tab === "agents" ? getAgentsHints()
    : tab === "tools" ? getToolsHints()
    : tab === "flows" ? getFlowsHints()
    : tab === "compute" ? getComputeHints()
    : tab === "history" ? getHistoryHints()
    : tab === "costs" ? getCostsHints()
    : getGenericHints(),
  [tab, pane, overlay, selectedSession]);

  return (
    <Box flexDirection="column">
      {error && (
        <Box>
          <Text color={theme.error}>{` ${error}`}</Text>
        </Box>
      )}
      <Box>
        <Text bold>{` ${sessions.length} sessions`}</Text>
        {!loading && nRun > 0 && <Text color={theme.running}>{`  ● ${nRun} running`}</Text>}
        {nErr > 0 && <Text color={theme.error}>{`  ✕ ${nErr} failed`}</Text>}
        <Text>{"   "}</Text>
        {hints}
      </Box>
    </Box>
  );
}

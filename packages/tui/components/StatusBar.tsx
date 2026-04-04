import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { getTheme } from "../../core/theme.js";
import { getActiveProfile } from "../../core/index.js";
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
  const profile = useMemo(() => { try { return getActiveProfile(); } catch { return "default"; } }, []);

  const counts = useMemo(() => {
    const c = { running: 0, waiting: 0, stopped: 0, completed: 0, failed: 0 };
    for (const s of sessions) {
      if (s.status === "running") c.running++;
      else if (s.status === "waiting" || s.status === "blocked") c.waiting++;
      else if (s.status === "stopped") c.stopped++;
      else if (s.status === "completed") c.completed++;
      else if (s.status === "failed") c.failed++;
    }
    return c;
  }, [sessions]);

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
        {profile !== "default" && <Text color="magenta">{` [${profile}]`}</Text>}
        <Text bold>{` ${sessions.length} sessions`}</Text>
        {!loading && counts.running > 0 && <Text color={theme.running}>{`  ● ${counts.running}`}</Text>}
        {counts.waiting > 0 && <Text color={theme.waiting}>{`  ◑ ${counts.waiting}`}</Text>}
        {counts.completed > 0 && <Text color={theme.running}>{`  ✔ ${counts.completed}`}</Text>}
        {counts.failed > 0 && <Text color={theme.error}>{`  ✕ ${counts.failed}`}</Text>}
        <Text>{"   "}</Text>
        {hints}
      </Box>
    </Box>
  );
}

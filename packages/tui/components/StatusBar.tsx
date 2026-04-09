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
  getSchedulesHints,
  getMemoryHints,
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
    : tab === "memory" ? getMemoryHints()
    : tab === "costs" ? getCostsHints()
    : tab === "schedules" ? getSchedulesHints()
    : getGenericHints(),
  [tab, pane, overlay, selectedSession]);

  const [primaryHints, secondaryHints] = useMemo(() => {
    if (!hints.length) return [[], []];
    // Split at the last separator -- everything after it goes to line 2
    const sepIdx = hints.reduce((last, h, i) =>
      React.isValidElement(h) && h.key?.toString().startsWith("sep-") ? i : last, -1);
    if (sepIdx > 0) {
      return [hints.slice(0, sepIdx), hints.slice(sepIdx + 1)];
    }
    return [hints, []];
  }, [hints]);

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
        {primaryHints}
      </Box>
      {secondaryHints.length > 0 && (
        <Box>
          <Text>{"  "}</Text>
          {secondaryHints}
        </Box>
      )}
    </Box>
  );
}

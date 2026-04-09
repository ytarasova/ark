import React, { useMemo } from "react";
import { Box, Text, useStdout } from "ink";
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
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 120;
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

  // Build the secondary bar text for padding calculation
  const secondaryText = useMemo(() => {
    if (!secondaryHints.length) return "";
    // Rough character count for padding
    let len = 1; // leading space
    for (const h of secondaryHints) {
      if (React.isValidElement(h) && h.props?.k && h.props?.label) {
        len += h.props.k.length + 1 + h.props.label.length + 2; // "k:label  "
      }
    }
    return len;
  }, [secondaryHints]);

  return (
    <Box flexDirection="column">
      {error && (
        <Box>
          <Text color={theme.error}>{` ${error}`}</Text>
        </Box>
      )}
      <Box>
        <Box>
          {profile !== "default" && <Text color="magenta">{` [${profile}]`}</Text>}
          <Text bold>{` ${sessions.length} sessions`}</Text>
          {!loading && counts.running > 0 && <Text color={theme.running}>{`  ● ${counts.running}`}</Text>}
          {counts.waiting > 0 && <Text color={theme.waiting}>{`  ◑ ${counts.waiting}`}</Text>}
          {counts.completed > 0 && <Text color={theme.running}>{`  ✔ ${counts.completed}`}</Text>}
          {counts.failed > 0 && <Text color={theme.error}>{`  ✕ ${counts.failed}`}</Text>}
        </Box>
        <Box flexGrow={1} justifyContent="flex-end">
          {primaryHints}
        </Box>
      </Box>
      {secondaryHints.length > 0 && (
        <Box>
          <Text backgroundColor={theme.surface}>
            {" "}
          </Text>
          {secondaryHints.map((hint, i) =>
            React.isValidElement(hint)
              ? React.cloneElement(hint as React.ReactElement, {
                  key: hint.key ?? `sh-${i}`,
                  children: React.Children.map(
                    (hint as React.ReactElement).props.children,
                    (child) => React.isValidElement(child)
                      ? React.cloneElement(child as React.ReactElement, { backgroundColor: theme.surface })
                      : child,
                  ),
                })
              : hint,
          )}
          <Text backgroundColor={theme.surface}>
            {" ".repeat(Math.max(0, columns - (secondaryText as number) - 1))}
          </Text>
        </Box>
      )}
    </Box>
  );
}

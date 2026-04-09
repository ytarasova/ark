import React, { useMemo } from "react";
import { Box, Text, useStdout } from "ink";
import { getTheme } from "../../core/theme.js";
import { getActiveProfile } from "../../core/index.js";
import type { Session } from "../../core/index.js";
import { flattenHints, NAV_BAR_TEXT } from "../helpers/statusBarHints.js";

interface StatusBarProps {
  /** Context-specific hints from the active tab (line 1, right-aligned) */
  hints: React.ReactNode[];
  /** Override bar text for overlays (replaces nav bar) */
  overlayBarText?: string | null;
  sessions: Session[];
  loading: boolean;
  error: string | null;
}

export function StatusBar({ hints, overlayBarText, sessions, loading, error }: StatusBarProps) {
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

  const barText = overlayBarText ?? NAV_BAR_TEXT;

  return (
    <Box flexDirection="column">
      {error && (
        <Box>
          <Text color={theme.error}>{` ${error}`}</Text>
        </Box>
      )}
      {!overlayBarText && (
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
            {hints}
          </Box>
        </Box>
      )}
      <Box>
        <Text backgroundColor={theme.surface} color={theme.text}>
          {` ${barText}`.padEnd(columns)}
        </Text>
      </Box>
    </Box>
  );
}

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import type { Tab } from "./TabBar.js";
import type { Session } from "../../core/index.js";

interface StatusBarProps {
  tab: Tab;
  sessions: Session[];
  loading: boolean;
  error: string | null;
  label: string | null;
}

const KEY_HINTS: Record<Tab, string> = {
  sessions: "j/k:move  Enter:dispatch  a:attach  c:done  s:stop  r:resume  n:new  x:kill  e:events  q:quit",
  hosts: "j/k:move  Enter:provision  s:start/stop  e:events  a:ssh  c:clean  n:new  x:del  q:quit",
  agents: "j/k:move  e:events  q:quit",
  pipelines: "j/k:move  e:events  q:quit",
  recipes: "e:events  q:quit",
};

export function StatusBar({ tab, sessions, loading, error, label }: StatusBarProps) {
  const nRun = sessions.filter((s) => s.status === "running").length;
  const nWait = sessions.filter((s) => s.status === "waiting").length;
  const nErr = sessions.filter((s) => s.status === "failed").length;

  return (
    <Box flexDirection="column">
      {loading && label && (
        <Box>
          <Text color="yellow">
            <Spinner type="dots" />
            {` ${label}`}
          </Text>
        </Box>
      )}
      {error && (
        <Box>
          <Text color="red">{` ${error}`}</Text>
        </Box>
      )}
      <Box>
        <Text>{` ${sessions.length} sessions`}</Text>
        {nRun > 0 && <Text color="blue">{`  ● ${nRun} running`}</Text>}
        {nWait > 0 && <Text color="yellow">{`  ⏸ ${nWait} waiting`}</Text>}
        {nErr > 0 && <Text color="red">{`  ✕ ${nErr} errors`}</Text>}
        <Text dimColor>{`   ${KEY_HINTS[tab]}`}</Text>
      </Box>
    </Box>
  );
}

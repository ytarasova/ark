import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { getTheme } from "../../core/theme.js";

export type Tab = "sessions" | "agents" | "events" | "flows" | "compute" | "history" | "memory" | "tools" | "schedules" | "costs";

export const TABS: Tab[] = ["sessions", "agents", "events", "flows", "compute", "history", "memory", "tools", "schedules", "costs"];

const TAB_KEYS: Record<Tab, string> = {
  sessions: "1",
  agents: "2",
  events: "3",
  flows: "4",
  compute: "5",
  history: "6",
  memory: "7",
  tools: "8",
  schedules: "9",
  costs: "0",
};

interface TabBarProps {
  active: Tab;
  loading?: boolean;
  loadingLabel?: string | null;
}

export function TabBar({ active, loading, loadingLabel }: TabBarProps) {
  const theme = getTheme();
  return (
    <Box>
      {TABS.map((tab) => {
        const isActive = tab === active;
        const key = TAB_KEYS[tab];
        const label = key ? `${key}:${tab.charAt(0).toUpperCase() + tab.slice(1)}` : tab.charAt(0).toUpperCase() + tab.slice(1);
        return (
          <Box key={tab} marginRight={1}>
            {isActive ? (
              <Text backgroundColor={theme.highlight} color={theme.text} bold>{` ${label} `}</Text>
            ) : (
              <Text dimColor>{` ${label} `}</Text>
            )}
          </Box>
        );
      })}
      <Box flexGrow={1} />
      {loading && (
        <Text color={theme.waiting}>
          <Spinner type="dots" />
          {loadingLabel ? ` ${loadingLabel}` : ""}
        </Text>
      )}
    </Box>
  );
}

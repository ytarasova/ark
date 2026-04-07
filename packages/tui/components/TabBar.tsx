import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export type Tab = "sessions" | "agents" | "tools" | "flows" | "history" | "compute" | "costs" | "schedules";

export const TABS: Tab[] = ["sessions", "agents", "tools", "flows", "history", "compute", "costs", "schedules"];

const TAB_KEYS: Record<Tab, string> = {
  sessions: "1",
  agents: "2",
  tools: "3",
  flows: "4",
  history: "5",
  compute: "6",
  costs: "7",
  schedules: "8",
};

interface TabBarProps {
  active: Tab;
  loading?: boolean;
  loadingLabel?: string | null;
}

export function TabBar({ active, loading, loadingLabel }: TabBarProps) {
  return (
    <Box>
      {TABS.map((tab) => {
        const isActive = tab === active;
        const key = TAB_KEYS[tab];
        const label = `${key}:${tab.charAt(0).toUpperCase() + tab.slice(1)}`;
        return (
          <Box key={tab} marginRight={1}>
            {isActive ? (
              <Text backgroundColor="cyan" color="white" bold>{` ${label} `}</Text>
            ) : (
              <Text dimColor>{` ${label} `}</Text>
            )}
          </Box>
        );
      })}
      <Box flexGrow={1} />
      {loading && (
        <Text color="yellow">
          <Spinner type="dots" />
          {loadingLabel ? ` ${loadingLabel}` : ""}
        </Text>
      )}
    </Box>
  );
}

import React from "react";
import { Box, Text } from "ink";

export type Tab = "sessions" | "agents" | "tools" | "flows" | "history" | "compute";

export const TABS: Tab[] = ["sessions", "agents", "tools", "flows", "history", "compute"];

const TAB_KEYS: Record<Tab, string> = {
  sessions: "1",
  agents: "2",
  tools: "3",
  flows: "4",
  history: "5",
  compute: "6",
};

interface TabBarProps {
  active: Tab;
}

export function TabBar({ active }: TabBarProps) {
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
    </Box>
  );
}

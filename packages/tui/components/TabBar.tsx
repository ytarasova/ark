import React from "react";
import { Box, Text } from "ink";

export type Tab = "sessions" | "compute" | "agents" | "flows" | "recipes";

export const TABS: Tab[] = ["sessions", "compute", "agents", "flows", "recipes"];

const TAB_KEYS: Record<Tab, string> = {
  sessions: "1",
  compute: "2",
  agents: "3",
  flows: "4",
  recipes: "5",
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

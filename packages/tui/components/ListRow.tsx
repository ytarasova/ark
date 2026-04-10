import React from "react";
import { Text } from "ink";
import { getTheme } from "../../core/theme.js";

interface ListRowProps {
  selected: boolean;
  children: string;
}

/**
 * A list row with colored highlight when selected.
 * Uses theme.accent for clear visibility on both dark and light terminals.
 */
export function ListRow({ selected, children }: ListRowProps) {
  const theme = getTheme();
  return (
    <Text
      bold={selected}
      backgroundColor={selected ? theme.accent : undefined}
      color={selected ? "white" : undefined}
      wrap="truncate"
    >
      {children}
    </Text>
  );
}

import React from "react";
import { Text } from "ink";
import { getTheme } from "../../core/theme.js";

interface ListRowProps {
  selected: boolean;
  children: string;
}

/**
 * A list row with subtle background highlight when selected.
 * Uses theme.highlight (raised surface) with bright text for contrast.
 */
export function ListRow({ selected, children }: ListRowProps) {
  const theme = getTheme();
  return (
    <Text
      bold={selected}
      backgroundColor={selected ? theme.highlight : undefined}
      color={selected ? theme.accent : undefined}
      wrap="truncate"
    >
      {children}
    </Text>
  );
}

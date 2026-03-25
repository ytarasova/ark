import React from "react";
import { Text } from "ink";

interface ListRowProps {
  selected: boolean;
  children: string;
}

/**
 * A list row with inverse highlight when selected.
 * Truncates at panel edge instead of wrapping.
 */
export function ListRow({ selected, children }: ListRowProps) {
  return (
    <Text bold={selected} inverse={selected} wrap="truncate">
      {children}
    </Text>
  );
}

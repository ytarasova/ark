import React from "react";
import { Text } from "ink";

interface KeyValueProps {
  label: string;
  children: React.ReactNode;
  /** Label column width in chars (default 13) */
  width?: number;
}

/**
 * Consistent label-value row for detail panels.
 * Label is dim, right-padded to fixed width.
 */
export function KeyValue({ label, children, width = 13 }: KeyValueProps) {
  return (
    <Text>
      <Text dimColor>{`  ${label}`.padEnd(width)}</Text>
      {children}
    </Text>
  );
}

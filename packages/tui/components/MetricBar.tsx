import React from "react";
import { Box, Text } from "ink";

interface MetricBarProps {
  label: string;
  value: number;
  max: number;
  suffix?: string;
  width?: number;
}

export function MetricBar({ label, value, max, suffix, width = 30 }: MetricBarProps) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  const filled = Math.round((pct / 100) * width);
  const empty = Math.max(0, width - filled);
  const color = pct > 80 ? "red" : pct > 50 ? "yellow" : "green";

  return (
    <Box>
      <Text>{` ${label.padEnd(6)}`}</Text>
      <Text color={color}>{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(empty)}</Text>
      <Text>{`  ${suffix ?? `${pct.toFixed(1)}%`}`}</Text>
    </Box>
  );
}

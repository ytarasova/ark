import React from "react";
import { Box, Text } from "ink";

interface Column {
  key: string;
  label: string;
  /** Fixed width in chars. Last column can omit to fill remaining space. */
  width?: number;
}

interface DataTableProps {
  columns: Column[];
   
  rows: readonly any[];
  /** Max rows to display (default: all) */
  limit?: number;
}

/**
 * Tabular data with dim header row. Content truncates at panel edge
 * via parent overflow="hidden".
 */
export function DataTable({ columns, rows, limit }: DataTableProps) {
  const display = limit ? rows.slice(0, limit) : rows;

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {"  "}
        {columns.map((col, i) =>
          col.width
            ? col.label.padEnd(col.width)
            : col.label
        ).join("")}
      </Text>
      {display.map((row, i) => (
        <Text key={i} wrap="truncate">
          {"  "}
          {columns.map((col, j) => {
            const val = String(row[col.key] ?? "");
            return col.width ? val.padEnd(col.width) : val;
          }).join("")}
        </Text>
      ))}
    </Box>
  );
}

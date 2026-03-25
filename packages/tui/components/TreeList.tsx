import React from "react";
import { Box, Text } from "ink";
import { ListRow } from "./ListRow.js";
import { ScrollBox } from "./ScrollBox.js";

interface TreeListProps<T> {
  items: T[];
  /** Group items by this key. Ungrouped items go under "" group. */
  groupBy?: (item: T) => string;
  /** Extra group names to show even if they have no items (empty buckets). */
  emptyGroups?: string[];
  /** Render a single row as a plain string (for ListRow highlight). */
  renderRow: (item: T, selected: boolean) => string;
  /** Render colored version for unselected rows (optional). If not provided, uses renderRow. */
  renderColoredRow?: (item: T) => React.ReactNode;
  /** Children to render under an item (e.g. fork children in sessions). */
  renderChildren?: (item: T) => React.ReactNode;
  /** Currently selected index (in the flat items array). */
  sel: number;
  /** Message when list is empty and no groups exist. */
  emptyMessage?: string;
}

/**
 * Grouped or flat list for left panels. Items are grouped by a key,
 * each group gets a header. Flat lists = single unnamed group.
 * Uses ScrollBox with followIndex for automatic scrolling.
 */
export function TreeList<T>({
  items,
  groupBy,
  emptyGroups,
  renderRow,
  renderColoredRow,
  renderChildren,
  sel,
  emptyMessage = "No items.",
}: TreeListProps<T>) {
  // Group items
  const groups = new Map<string, { item: T; flatIndex: number }[]>();
  items.forEach((item, i) => {
    const key = groupBy ? groupBy(item) : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ item, flatIndex: i });
  });

  // Add empty groups that aren't already represented
  for (const g of emptyGroups ?? []) {
    if (!groups.has(g)) groups.set(g, []);
  }

  // Sort: unnamed group first, then alphabetical
  const sortedKeys = [...groups.keys()].sort((a, b) =>
    a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)
  );

  if (items.length === 0 && sortedKeys.filter(k => k !== "").length === 0) {
    return <Text dimColor>{`  ${emptyMessage}`}</Text>;
  }

  // Build flat list of renderable rows for ScrollBox
  // Track which row index corresponds to the selected item
  const rows: React.ReactNode[] = [];
  let selRow = 0;

  for (const groupName of sortedKeys) {
    const entries = groups.get(groupName)!;
    if (groupName) {
      rows.push(
        <Text key={`grp-${groupName}`} backgroundColor="gray" color="white">{` ${groupName} `}</Text>
      );
    }
    if (entries.length === 0 && groupName) {
      rows.push(<Text key={`empty-${groupName}`} dimColor>{"    (empty)"}</Text>);
    }
    for (const { item, flatIndex } of entries) {
      const isSel = flatIndex === sel;
      if (isSel) selRow = rows.length;
      rows.push(
        <Box key={`item-${flatIndex}`} flexDirection="column">
          {isSel ? (
            <ListRow selected>{renderRow(item, true)}</ListRow>
          ) : (
            renderColoredRow
              ? renderColoredRow(item)
              : <Text>{renderRow(item, false)}</Text>
          )}
          {renderChildren?.(item)}
        </Box>
      );
    }
  }

  return (
    <ScrollBox followIndex={selRow} active={false} reserveRows={9}>
      {rows}
    </ScrollBox>
  );
}

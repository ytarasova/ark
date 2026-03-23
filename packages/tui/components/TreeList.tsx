import React from "react";
import { Box, Text } from "ink";
import { ListRow } from "./ListRow.js";

interface TreeListProps<T> {
  items: T[];
  /** Group items by this key. Ungrouped items go under "" group. */
  groupBy?: (item: T) => string;
  /** Render a single row as a plain string (for ListRow highlight). */
  renderRow: (item: T, selected: boolean) => string;
  /** Render colored version for unselected rows (optional). If not provided, uses renderRow. */
  renderColoredRow?: (item: T) => React.ReactNode;
  /** Children to render under an item (e.g. fork children in sessions). */
  renderChildren?: (item: T) => React.ReactNode;
  /** Currently selected index (in the flat items array). */
  sel: number;
  /** Message when list is empty. */
  emptyMessage?: string;
}

/**
 * Grouped or flat list for left panels. Items are grouped by a key,
 * each group gets a header. Flat lists = single unnamed group.
 * Selected row fills panel width via ListRow.
 */
export function TreeList<T>({
  items,
  groupBy,
  renderRow,
  renderColoredRow,
  renderChildren,
  sel,
  emptyMessage = "No items.",
}: TreeListProps<T>) {
  if (items.length === 0) {
    return <Text dimColor>{`  ${emptyMessage}`}</Text>;
  }

  // Group items
  const groups = new Map<string, { item: T; flatIndex: number }[]>();
  items.forEach((item, i) => {
    const key = groupBy ? groupBy(item) : "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ item, flatIndex: i });
  });

  // Sort: unnamed group first, then alphabetical
  const sortedKeys = [...groups.keys()].sort((a, b) =>
    a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)
  );

  return (
    <Box flexDirection="column">
      {sortedKeys.map(groupName => {
        const entries = groups.get(groupName)!;
        return (
          <Box key={groupName || "__ungrouped"} flexDirection="column">
            {groupName ? (
              <Text backgroundColor="gray" color="white">{` ${groupName} `}</Text>
            ) : null}
            {entries.map(({ item, flatIndex }) => {
              const isSel = flatIndex === sel;
              return (
                <Box key={flatIndex} flexDirection="column">
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
            })}
          </Box>
        );
      })}
    </Box>
  );
}

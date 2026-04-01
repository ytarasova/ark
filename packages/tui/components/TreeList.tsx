import React, { useMemo, useEffect, useRef } from "react";
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
  /**
   * Currently selected visual index (0 = first visible item).
   * IMPORTANT: When using groupBy, items are sorted by group (unnamed first,
   * then alphabetical). Callers must pre-sort their items array to match
   * this order, or use onSelect to get the actual selected item.
   */
  sel: number;
  /** Called with the actual selected item when sel changes. Use this instead of items[sel] when groupBy is set. */
  onSelect?: (item: T | null) => void;
  /** Message when list is empty and no groups exist. */
  emptyMessage?: string;
}

/**
 * Grouped or flat list for left panels.
 *
 * Items are grouped by a key, each group gets a header.
 * Flat lists = single unnamed group. Uses ScrollBox with
 * followIndex for automatic scrolling.
 *
 * @param groupBy - Categorize items into named groups; return value becomes the group header.
 * @param renderChildren - Render extra nodes beneath an item (e.g. fork children in sessions).
 */
export function TreeList<T>({
  items,
  groupBy,
  emptyGroups,
  renderRow,
  renderColoredRow,
  renderChildren,
  sel,
  onSelect,
  emptyMessage = "No items.",
}: TreeListProps<T>) {
  // Group items and sort keys (memoized to avoid rebuilding on every render)
  const { sortedKeys, groupMap } = useMemo(() => {
    const gm = new Map<string, { item: T; flatIndex: number }[]>();
    items.forEach((item, i) => {
      const key = groupBy ? groupBy(item) : "";
      if (!gm.has(key)) gm.set(key, []);
      gm.get(key)!.push({ item, flatIndex: i });
    });

    // Add empty groups that aren't already represented
    for (const g of emptyGroups ?? []) {
      if (!gm.has(g)) gm.set(g, []);
    }

    // Sort: unnamed group first, then alphabetical
    const sk = [...gm.keys()].sort((a, b) =>
      a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)
    );

    return { sortedKeys: sk, groupMap: gm };
  }, [items, groupBy, emptyGroups]);

  if (items.length === 0 && sortedKeys.filter(k => k !== "").length === 0) {
    return <Text dimColor>{`  ${emptyMessage}`}</Text>;
  }

  // Build flat list of renderable rows for ScrollBox
  const rows: React.ReactNode[] = [];
  let selRow = 0;
  let visualIdx = 0;
  let selectedItem: T | null = null;

  for (const groupName of sortedKeys) {
    const entries = groupMap.get(groupName)!;
    if (groupName) {
      rows.push(
        <Text key={`grp-${groupName}`} backgroundColor="gray" color="white">{` ${groupName} `}</Text>
      );
    }
    if (entries.length === 0 && groupName) {
      rows.push(<Text key={`empty-${groupName}`} dimColor>{"    (empty)"}</Text>);
    }
    for (const { item, flatIndex } of entries) {
      const isSel = visualIdx === sel;
      visualIdx++;
      if (isSel) { selRow = rows.length; selectedItem = item; }
      rows.push(
        <Box key={`item-${flatIndex}`} flexDirection="column">
          {isSel ? (
            <ListRow selected>{`> ${renderRow(item, true)}`}</ListRow>
          ) : (
            renderColoredRow
              ? renderColoredRow(item)
              : <Text wrap="truncate">{`  ${renderRow(item, false)}`}</Text>
          )}
          {renderChildren?.(item)}
        </Box>
      );
    }
  }

  // Notify caller of selected item (avoids index mismatch when groupBy reorders)
  const prevSelRef = useRef<T | null>(null);
  useEffect(() => {
    if (onSelect && selectedItem !== prevSelRef.current) {
      prevSelRef.current = selectedItem;
      onSelect(selectedItem);
    }
  }, [sel, items]);

  return (
    <ScrollBox followIndex={selRow} active={false} reserveRows={9}>
      {rows}
    </ScrollBox>
  );
}

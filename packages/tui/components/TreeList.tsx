import React, { useMemo, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import { getTheme } from "../../core/theme.js";
import { ListRow } from "./ListRow.js";
import { ScrollBox } from "./ScrollBox.js";

interface TreeListProps<T> {
  items: T[];
  /** Group items by this key. Ungrouped items go under "" group. */
  groupBy?: (item: T) => string;
  /** Extra group names to show even if they have no items (empty buckets). */
  emptyGroups?: string[];
  /** Custom sort comparator for group keys. If not provided, unnamed first then alphabetical. */
  groupSort?: (a: string, b: string) => number;
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
  /** Add a blank line between rows for visual breathing room */
  spacing?: boolean;
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
  groupSort,
  renderRow,
  renderColoredRow,
  renderChildren,
  sel,
  onSelect,
  emptyMessage = "No items.",
  spacing = false,
}: TreeListProps<T>) {
  const theme = getTheme();
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

    // Sort: use custom comparator if provided, otherwise unnamed first then alphabetical
    const sk = [...gm.keys()].sort(groupSort ?? ((a, b) =>
      a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)
    ));

    return { sortedKeys: sk, groupMap: gm };
  }, [items, groupBy, emptyGroups, groupSort]);

  // Hooks MUST be called before any early return (React rules of hooks)
  const prevSelRef = useRef<T | null>(null);

  // Clamp sel to valid range to handle one-render-cycle delay from useListNavigation
  const clampedSel = items.length > 0 ? Math.min(sel, items.length - 1) : 0;

  // Build flat list of renderable rows for ScrollBox
  const rows: React.ReactNode[] = [];
  let selRow = 0;
  let visualIdx = 0;
  let selectedItem: T | null = null;

  const isEmpty = items.length === 0 && sortedKeys.filter(k => k !== "").length === 0;

  if (!isEmpty) {
    for (const groupName of sortedKeys) {
      const entries = groupMap.get(groupName)!;
      if (groupName) {
        rows.push(
          <Text key={`grp-${groupName}`} backgroundColor={theme.highlight} color={theme.text} bold>{` ${groupName} `}</Text>
        );
      }
      if (entries.length === 0 && groupName) {
        rows.push(<Text key={`empty-${groupName}`} dimColor>{"    (empty)"}</Text>);
      }
      for (const { item, flatIndex } of entries) {
        const isSel = visualIdx === clampedSel;
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
        if (spacing) {
          rows.push(<Text key={`sp-${flatIndex}`}>{" "}</Text>);
        }
      }
    }
  }

  // Notify caller of selected item (avoids index mismatch when groupBy reorders)
  useEffect(() => {
    if (onSelect && selectedItem !== prevSelRef.current) {
      prevSelRef.current = selectedItem;
      onSelect(selectedItem);
    }
  }, [sel, items]);

  if (isEmpty) {
    return <Text dimColor>{`  ${emptyMessage}`}</Text>;
  }

  return (
    <ScrollBox followIndex={selRow} active={false} reserveRows={9}>
      {rows}
    </ScrollBox>
  );
}

import React, { useMemo, useEffect, useRef } from "react";
import { Box, Text, useInput } from "ink";
import { getTheme } from "../../core/theme.js";
import { ListRow } from "./ListRow.js";
import { ScrollBox } from "./ScrollBox.js";

const PAGE_SIZE = 20;

interface TreeListProps<T> {
  items: T[];
  /** Unique identity for each item. Used for stable selection across reorders. */
  getKey: (item: T) => string;
  /** Group items by this key. Ungrouped items go under "" group. */
  groupBy?: (item: T) => string;
  /** Extra group names to show even if they have no items (empty buckets). */
  emptyGroups?: string[];
  /** Custom sort comparator for group keys. */
  groupSort?: (a: string, b: string) => number;
  /** Render a single row as a plain string (for ListRow highlight). */
  renderRow: (item: T, selected: boolean) => string;
  /** Render colored version for unselected rows (optional). */
  renderColoredRow?: (item: T) => React.ReactNode;
  /** Children to render under an item (visual only, not navigable). */
  renderChildren?: (item: T) => React.ReactNode;
  /** Currently selected item key (controlled). null = nothing selected. */
  selectedKey: string | null;
  /** Called when selection changes (j/k navigation or list reorder). */
  onSelect: (item: T | null) => void;
  /** Whether TreeList handles keyboard input (j/k/f/b/g/G). */
  active?: boolean;
  /** Message when list is empty. */
  emptyMessage?: string;
  /** Add blank line between rows. */
  spacing?: boolean;
}

type TreeNode<T> =
  | { type: "group"; key: string; label: string; count: number }
  | { type: "item"; key: string; data: T }
  | { type: "empty"; key: string }
  | { type: "spacing"; key: string };

/**
 * Grouped or flat list for left panels.
 *
 * Owns navigation (j/k/f/b/g/G), uses key-based selection, builds an
 * internal TreeNode[] model, and eliminates the pre-sort requirement
 * from callers.
 */
export function TreeList<T>({
  items,
  getKey,
  groupBy,
  emptyGroups,
  groupSort,
  renderRow,
  renderColoredRow,
  renderChildren,
  selectedKey,
  onSelect,
  active = false,
  emptyMessage = "No items.",
  spacing = false,
}: TreeListProps<T>) {
  const theme = getTheme();

  // Build tree model: group items, sort groups, produce flat TreeNode[]
  const { nodes, selectableItems } = useMemo(() => {
    // Group items
    const groupMap = new Map<string, T[]>();
    for (const item of items) {
      const gk = groupBy ? groupBy(item) : "";
      if (!groupMap.has(gk)) groupMap.set(gk, []);
      groupMap.get(gk)!.push(item);
    }

    // Add empty groups
    for (const g of emptyGroups ?? []) {
      if (!groupMap.has(g)) groupMap.set(g, []);
    }

    // Sort group keys
    const sortedKeys = [...groupMap.keys()].sort(groupSort ?? ((a, b) =>
      a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)
    ));

    const treeNodes: TreeNode<T>[] = [];
    const selItems: T[] = [];

    for (const groupName of sortedKeys) {
      const groupItems = groupMap.get(groupName)!;

      // Group header
      if (groupName) {
        treeNodes.push({ type: "group", key: `grp-${groupName}`, label: groupName, count: groupItems.length });
      }

      // Empty placeholder
      if (groupItems.length === 0 && groupName) {
        treeNodes.push({ type: "empty", key: `empty-${groupName}` });
      }

      // Items
      for (const item of groupItems) {
        const itemKey = getKey(item);
        treeNodes.push({ type: "item", key: itemKey, data: item });
        selItems.push(item);
        if (spacing) {
          treeNodes.push({ type: "spacing", key: `sp-${itemKey}` });
        }
      }
    }

    return { nodes: treeNodes, selectableItems: selItems };
  }, [items, groupBy, emptyGroups, groupSort, getKey, spacing]);

  // Find current selection index within selectableItems
  const selIndex = useMemo(() => {
    if (selectedKey === null || selectableItems.length === 0) return -1;
    return selectableItems.findIndex(item => getKey(item) === selectedKey);
  }, [selectedKey, selectableItems, getKey]);

  // Auto-select first item when selectedKey doesn't match any item
  const prevItemsRef = useRef(selectableItems);
  useEffect(() => {
    if (selectableItems.length === 0) {
      if (selectedKey !== null) onSelect(null);
    } else if (selIndex === -1) {
      // selectedKey doesn't match -- select first item
      onSelect(selectableItems[0]);
    }
    prevItemsRef.current = selectableItems;
  }, [selectableItems, selIndex]);

  // Navigation: j/k/f/b/g/G
  useInput((input, key) => {
    if (!active || selectableItems.length === 0) return;
    const max = selectableItems.length - 1;
    const cur = selIndex >= 0 ? selIndex : 0;
    let next = cur;

    if (input === "j" || key.downArrow) {
      next = Math.min(cur + 1, max);
    } else if (input === "k" || key.upArrow) {
      next = Math.max(cur - 1, 0);
    } else if (input === "f" || key.pageDown) {
      next = Math.min(cur + PAGE_SIZE, max);
    } else if (input === "b" || key.pageUp) {
      next = Math.max(cur - PAGE_SIZE, 0);
    } else if (input === "g") {
      next = 0;
    } else if (input === "G") {
      next = max;
    } else {
      return; // Not a navigation key
    }

    if (next !== cur || selIndex === -1) {
      onSelect(selectableItems[next]);
    }
  });

  // Compute followIndex for ScrollBox: position of selected node in the full
  // nodes array, backing up to show group header when first item in group is selected
  const followIndex = useMemo(() => {
    if (selIndex < 0 || selectableItems.length === 0) return 0;
    const selKey = getKey(selectableItems[selIndex]);
    // Find the node index in the full nodes array
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.type === "item" && node.key === selKey) {
        // Check if previous node is a group header -- if so, follow the header
        if (i > 0 && nodes[i - 1].type === "group") {
          return i - 1;
        }
        return i;
      }
    }
    return 0;
  }, [nodes, selIndex, selectableItems, getKey]);

  // Empty state
  const isEmpty = items.length === 0 && (emptyGroups ?? []).filter(g => g !== "").length === 0;
  if (isEmpty) {
    return <Text dimColor>{`  ${emptyMessage}`}</Text>;
  }

  // Render nodes
  const rows: React.ReactNode[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "group":
        rows.push(
          <Text key={node.key} color={theme.accent} bold wrap="truncate">
            {`${node.label} (${node.count})`}
          </Text>
        );
        break;
      case "empty":
        rows.push(<Text key={node.key} dimColor>{"    (empty)"}</Text>);
        break;
      case "spacing":
        rows.push(<Text key={node.key}>{" "}</Text>);
        break;
      case "item": {
        const isSel = selectedKey !== null && node.key === selectedKey;
        const rowContent = isSel ? (
          <ListRow selected>{`> ${renderRow(node.data, true)}`}</ListRow>
        ) : (
          renderColoredRow
            ? renderColoredRow(node.data)
            : <Text wrap="truncate">{`  ${renderRow(node.data, false)}`}</Text>
        );
        const children = renderChildren?.(node.data);
        if (children) {
          rows.push(
            <Box key={node.key} flexDirection="column">
              {rowContent}
              {children}
            </Box>
          );
        } else {
          rows.push(<React.Fragment key={node.key}>{rowContent}</React.Fragment>);
        }
        break;
      }
    }
  }

  return (
    <ScrollBox followIndex={followIndex} active={false}>
      {rows}
    </ScrollBox>
  );
}

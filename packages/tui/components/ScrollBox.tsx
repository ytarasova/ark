import React, { useState, useEffect, Children, useMemo } from "react";
import { Box, Text, useInput, useStdout } from "ink";

interface ScrollBoxProps {
  children: React.ReactNode;
  /** Reserve this many rows for chrome outside the scroll area (tabs, status bar, etc.) */
  reserveRows?: number;
  /** Whether this scroll box should respond to its own j/k scroll keys */
  active?: boolean;
  /**
   * Follow an external selection index (for list panes).
   * When set, the scroll box auto-scrolls to keep this index visible
   * and does NOT handle j/k internally (the parent owns navigation).
   */
  followIndex?: number;
}

/**
 * Scrollable container that clips children to terminal height.
 *
 * Two modes:
 * 1. Self-managed (default): responds to j/k for scrolling. Used by right/detail panes.
 * 2. Follow mode (followIndex set): auto-scrolls to keep the followed index visible.
 *    Used by left/list panes where useListNavigation owns j/k.
 */
export function ScrollBox({ children, reserveRows = 6, active = true, followIndex }: ScrollBoxProps) {
  const { stdout } = useStdout();
  const maxHeight = (stdout?.rows ?? 40) - reserveRows;
  const [offset, setOffset] = useState(0);

  const items = useMemo(() => {
    const flat: React.ReactNode[] = [];
    const flatten = (node: React.ReactNode) => {
      Children.forEach(node, (child) => {
        if (child === null || child === undefined) return;
        if (typeof child === "object" && "type" in (child as any)) {
          const el = child as React.ReactElement;
          if (el.type === React.Fragment) {
            flatten(el.props.children);
            return;
          }
        }
        flat.push(child);
      });
    };
    flatten(children);
    return flat;
  }, [children]);

  const total = items.length;
  const displayHeight = maxHeight - (total > maxHeight ? 1 : 0); // reserve 1 row for scroll indicator
  const maxOffset = Math.max(0, total - displayHeight);

  // Follow mode: auto-scroll to keep followIndex visible
  useEffect(() => {
    if (followIndex === undefined) return;
    const maxFollow = Math.max(0, total - 1);
    const clamped = Math.max(0, Math.min(followIndex, maxFollow));
    setOffset(prev => {
      if (clamped < prev) return clamped;
      if (clamped >= prev + displayHeight) return Math.max(0, clamped - displayHeight + 1);
      return prev;
    });
  }, [followIndex, displayHeight, total]);

  // Self-managed scroll (only when not in follow mode)
  useInput((input, key) => {
    if (!active || followIndex !== undefined) return;
    if (input === "j" || key.downArrow) {
      setOffset(o => Math.min(o + 1, maxOffset));
    } else if (input === "k" || key.upArrow) {
      setOffset(o => Math.max(o - 1, 0));
    } else if (input === "f" || key.pageDown) {
      // Page down
      setOffset(o => Math.min(o + displayHeight, maxOffset));
    } else if (input === "b" || key.pageUp) {
      // Page up
      setOffset(o => Math.max(o - displayHeight, 0));
    } else if (input === "g") {
      setOffset(0);
    } else if (input === "G") {
      setOffset(maxOffset);
    }
  });

  const canScroll = total > maxHeight;
  const visible = items.slice(offset, offset + displayHeight);

  return (
    <Box flexDirection="column" height={maxHeight} overflow="hidden">
      {visible.map((item, i) => (
        <React.Fragment key={offset + i}>{item}</React.Fragment>
      ))}
      {canScroll && (
        <Text dimColor>
          {offset > 0 ? " ▲" : "  "}
          {` ${offset + 1}–${Math.min(offset + displayHeight, total)}/${total} `}
          {offset < maxOffset ? "▼" : " "}
        </Text>
      )}
    </Box>
  );
}

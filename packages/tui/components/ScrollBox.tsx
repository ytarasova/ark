import React, { useState, Children, useMemo } from "react";
import { Box, Text, useInput, useStdout } from "ink";

interface ScrollBoxProps {
  children: React.ReactNode;
  /** Reserve this many rows for chrome outside the scroll area (tabs, status bar, etc.) */
  reserveRows?: number;
  /** Whether this scroll box should respond to scroll keys */
  active?: boolean;
}

/**
 * Scrollable container for detail panels. Clips children to the
 * available terminal height and scrolls with j/k when focused.
 * Shows a scroll position indicator when content overflows.
 */
export function ScrollBox({ children, reserveRows = 6, active = true }: ScrollBoxProps) {
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
  const maxOffset = Math.max(0, total - maxHeight);

  useInput((input, key) => {
    if (!active) return;
    if (input === "j" || key.downArrow) {
      setOffset(o => Math.min(o + 1, maxOffset));
    } else if (input === "k" || key.upArrow) {
      setOffset(o => Math.max(o - 1, 0));
    } else if (input === "J" || (key.downArrow && key.shift)) {
      setOffset(o => Math.min(o + 5, maxOffset));
    } else if (input === "K" || (key.upArrow && key.shift)) {
      setOffset(o => Math.max(o - 5, 0));
    } else if (input === "g") {
      setOffset(0);
    } else if (input === "G") {
      setOffset(maxOffset);
    }
  });

  // Reset offset when content changes significantly (different item selected)
  useMemo(() => setOffset(0), [total]);

  const canScroll = total > maxHeight;
  const visible = items.slice(offset, offset + maxHeight - (canScroll ? 1 : 0));

  return (
    <Box flexDirection="column" height={maxHeight} overflow="hidden">
      {visible.map((item, i) => (
        <React.Fragment key={offset + i}>{item}</React.Fragment>
      ))}
      {canScroll && (
        <Text dimColor>
          {offset > 0 ? " ▲" : "  "}
          {` ${offset + 1}–${Math.min(offset + maxHeight, total)}/${total} `}
          {offset < maxOffset ? "▼" : " "}
        </Text>
      )}
    </Box>
  );
}

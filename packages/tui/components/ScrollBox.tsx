import React, { useState, useMemo, useEffect, useCallback, Children, createContext, useContext } from "react";
import { Box, Text, useInput, useStdout } from "ink";

/**
 * Context for parent components to tell ScrollBox its available height.
 * When set, ScrollBox uses this instead of guessing from terminal rows.
 */
export const ScrollHeightContext = createContext<number | null>(null);

interface ScrollBoxProps {
  children: React.ReactNode;
  /**
   * Fallback: rows to subtract from terminal height when no
   * ScrollHeightContext is provided. Prefer using context.
   */
  reserveRows?: number;
  /** When true, this ScrollBox captures j/k/f/b scroll keys. */
  active?: boolean;
  /** Index of the item to keep visible (auto-scroll). */
  followIndex?: number;
  /** When this key changes, scroll resets to top. */
  resetKey?: string | number | null;
}

/**
 * Scrollable container that clips children to available height.
 *
 * Height is determined by (in priority order):
 * 1. ScrollHeightContext (parent tells us the exact height)
 * 2. terminalRows - reserveRows (fallback estimate)
 *
 * Two scroll modes:
 * 1. Self-managed (active): captures j/k/f/b keys for scrolling.
 * 2. Follow mode (followIndex set): auto-scrolls to keep the followed index visible.
 */
export function ScrollBox({ children, reserveRows = 10, active = true, followIndex, resetKey }: ScrollBoxProps) {
  const { stdout } = useStdout();
  const contextHeight = useContext(ScrollHeightContext);
  const maxHeight = contextHeight ?? ((stdout?.rows ?? 40) - reserveRows);
  const [offset, setOffset] = useState(0);

  // Reset scroll to top when resetKey changes
  useEffect(() => {
    setOffset(0);
  }, [resetKey]);

  const items = useMemo(() => {
    const flat: React.ReactNode[] = [];
    Children.forEach(children, (child) => {
      if (child === null || child === undefined) return;
      flat.push(child);
    });
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
      setOffset(o => Math.min(o + displayHeight, maxOffset));
    } else if (input === "b" || key.pageUp) {
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
          {` ${offset + 1}-${Math.min(offset + displayHeight, total)}/${total} `}
          {offset < maxOffset ? "▼" : " "}
        </Text>
      )}
    </Box>
  );
}

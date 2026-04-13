import React, { useState, useMemo, useEffect, useRef, Children } from "react";
import { Box, Text, useInput, measureElement } from "ink";

interface ScrollBoxProps {
  children: React.ReactNode;
  /** When true, this ScrollBox captures j/k/f/b scroll keys. */
  active?: boolean;
  /** Index of the item to keep visible (auto-scroll). */
  followIndex?: number;
  /** When this key changes, scroll resets to top. */
  resetKey?: string | number | null;
  /** Fallback height when measurement is unavailable. */
  reserveRows?: number;
}

/**
 * Scrollable container that measures its own available height
 * via Ink's measureElement, then slices children to fit.
 *
 * Two modes:
 * 1. Self-managed (active): captures j/k/f/b keys for scrolling.
 * 2. Follow mode (followIndex set): auto-scrolls to keep the followed index visible.
 */
export function ScrollBox({ children, active = true, followIndex, resetKey, reserveRows = 6 }: ScrollBoxProps) {
  const containerRef = useRef(null);
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const [offset, setOffset] = useState(0);

  // Measure the container's actual available height after render
  useEffect(() => {
    if (containerRef.current) {
      const { height } = measureElement(containerRef.current);
      if (height > 0 && height !== measuredHeight) {
        setMeasuredHeight(height);
      }
    }
  });

  // Fallback: estimate from terminal rows when measurement isn't available yet
  const maxHeight = measuredHeight > 0
    ? measuredHeight
    : ((process.stdout?.rows ?? 40) - reserveRows);

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
    <Box ref={containerRef} flexDirection="column" flexGrow={1} overflow="hidden">
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

import { useState, useEffect, useCallback } from "react";
import { useStdout, useInput } from "ink";

export type ScrollAlignment = "auto" | "center" | "top";

interface VirtualScrollOpts {
  /** Total number of items in the list. */
  total: number;
  /** Index of the item to keep visible. */
  selectedIndex?: number;
  /** How to position the selected item in the viewport. */
  alignment?: ScrollAlignment;
  /** Whether this scroll instance handles keyboard input. */
  active?: boolean;
  /** Explicit window size (number of visible rows). When provided, overrides terminal calculation. */
  windowSize?: number;
  /** Margin rows to subtract from terminal height for chrome (only used when windowSize is not set). */
  marginRows?: number;
}

interface VirtualScrollResult {
  /** First visible item index. */
  start: number;
  /** One past the last visible item index. */
  end: number;
  /** Number of visible items (window size). */
  windowSize: number;
  /** Scroll to top. */
  scrollToTop: () => void;
  /** Scroll to bottom. */
  scrollToBottom: () => void;
}

/**
 * Virtual scroll hook. Computes a visible window [start, end) of items
 * based on terminal height and selected index. Handles keyboard navigation
 * (j/k/f/b/g/G) when active.
 */
export function useVirtualScroll(opts: VirtualScrollOpts): VirtualScrollResult {
  const { total, selectedIndex, alignment = "center", active = false, marginRows = 8, windowSize: explicitWindow } = opts;
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 40;
  const windowSize = explicitWindow ?? Math.max(5, termRows - marginRows);
  const maxOffset = Math.max(0, total - windowSize);

  const [offset, setOffset] = useState(0);

  // Keep selectedIndex visible using the chosen alignment
  useEffect(() => {
    if (selectedIndex === undefined) return;
    setOffset(prev => {
      switch (alignment) {
        case "center": {
          return Math.max(0, Math.min(selectedIndex - Math.floor(windowSize / 2), maxOffset));
        }
        case "top": {
          return Math.max(0, Math.min(selectedIndex, maxOffset));
        }
        case "auto":
        default: {
          // Minimal scroll: only move if selected item is outside viewport
          if (selectedIndex < prev) return selectedIndex;
          if (selectedIndex >= prev + windowSize) return Math.min(selectedIndex - windowSize + 1, maxOffset);
          return prev;
        }
      }
    });
  }, [selectedIndex, windowSize, maxOffset, alignment]);

  const scrollToTop = useCallback(() => setOffset(0), []);
  const scrollToBottom = useCallback(() => setOffset(maxOffset), [maxOffset]);

  // Keyboard scrolling (only when active and no selectedIndex tracking)
  useInput((input, key) => {
    if (!active || selectedIndex !== undefined) return;
    if (input === "j" || key.downArrow) setOffset(o => Math.min(o + 1, maxOffset));
    else if (input === "k" || key.upArrow) setOffset(o => Math.max(o - 1, 0));
    else if (input === "f" || key.pageDown) setOffset(o => Math.min(o + windowSize, maxOffset));
    else if (input === "b" || key.pageUp) setOffset(o => Math.max(o - windowSize, 0));
    else if (input === "g") setOffset(0);
    else if (input === "G") setOffset(maxOffset);
  });

  return {
    start: offset,
    end: Math.min(offset + windowSize, total),
    windowSize,
    scrollToTop,
    scrollToBottom,
  };
}

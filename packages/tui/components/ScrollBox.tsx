import React, { useMemo, Children, createContext, useContext } from "react";
import { Box } from "ink";
import { useVirtualScroll, type ScrollAlignment } from "../hooks/useVirtualScroll.js";

/** Parent components set this to tell ScrollBox the exact available height. */
export const AvailableHeightContext = createContext<number>(30);

interface ScrollBoxProps {
  children: React.ReactNode;
  /** When true, this ScrollBox captures j/k/f/b scroll keys. */
  active?: boolean;
  /** Index of the child to keep visible (auto-scroll). */
  followIndex?: number;
  /** How to position the followed item. */
  alignment?: ScrollAlignment;
  /** When this key changes, scroll resets to top. */
  resetKey?: string | number | null;
}

/**
 * Virtual-scrolling container. Renders only a window of children
 * sized by AvailableHeightContext from the parent layout.
 */
export function ScrollBox({ children, active = true, followIndex, alignment = "center", resetKey }: ScrollBoxProps) {
  const availableHeight = useContext(AvailableHeightContext);

  const items = useMemo(() => {
    const flat: React.ReactNode[] = [];
    Children.forEach(children, (child) => {
      if (child === null || child === undefined) return;
      flat.push(child);
    });
    return flat;
  }, [children]);

  const { start, end } = useVirtualScroll({
    total: items.length,
    selectedIndex: followIndex,
    alignment,
    active,
    windowSize: availableHeight,
  });

  return (
    <Box flexDirection="column" height={availableHeight}>
      {items.slice(start, end)}
    </Box>
  );
}

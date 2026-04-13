import React, { useEffect, useRef } from "react";
import { useInput, useStdout } from "ink";
import { ScrollList, type ScrollListRef } from "ink-scroll-list";

interface ScrollBoxProps {
  children: React.ReactNode;
  /** When true, this ScrollBox captures j/k/f/b scroll keys. */
  active?: boolean;
  /** Index of the child to keep visible (auto-scroll). */
  followIndex?: number;
  /** When this key changes, scroll resets to top. */
  resetKey?: string | number | null;
}

/**
 * Scrollable list backed by ink-scroll-list.
 * Auto-scrolls to keep the selected item visible.
 * Parent Box must constrain the height.
 */
export function ScrollBox({ children, active = true, followIndex, resetKey }: ScrollBoxProps) {
  const listRef = useRef<ScrollListRef>(null);
  const { stdout } = useStdout();

  // Re-measure on terminal resize
  useEffect(() => {
    const onResize = () => listRef.current?.remeasure();
    stdout?.on("resize", onResize);
    return () => { stdout?.off("resize", onResize); };
  }, [stdout]);

  // Keyboard scrolling (only when not in follow mode)
  useInput((input, key) => {
    if (!active || followIndex !== undefined) return;
    const sv = listRef.current;
    if (!sv) return;
    const pageSize = sv.getViewportHeight() || 10;
    if (input === "j" || key.downArrow) sv.scrollBy(1);
    else if (input === "k" || key.upArrow) sv.scrollBy(-1);
    else if (input === "f" || key.pageDown) sv.scrollBy(pageSize);
    else if (input === "b" || key.pageUp) sv.scrollBy(-pageSize);
    else if (input === "g") sv.scrollToTop();
    else if (input === "G") sv.scrollToBottom();
  });

  return (
    <ScrollList ref={listRef} selectedIndex={followIndex ?? 0} scrollAlignment="center">
      {children}
    </ScrollList>
  );
}

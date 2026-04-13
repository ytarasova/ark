import React, { useEffect, useRef } from "react";
import { useInput, useStdout } from "ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";

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
 * Scrollable container backed by ink-scroll-view.
 * The parent Box must constrain the height (e.g. via flexGrow={1}
 * + overflow="hidden" on SplitPane's content area).
 */
export function ScrollBox({ children, active = true, followIndex, resetKey }: ScrollBoxProps) {
  const scrollRef = useRef<ScrollViewRef>(null);
  const { stdout } = useStdout();

  // Re-measure on terminal resize
  useEffect(() => {
    const onResize = () => scrollRef.current?.remeasure();
    stdout?.on("resize", onResize);
    return () => { stdout?.off("resize", onResize); };
  }, [stdout]);

  // Reset scroll to top when resetKey changes
  useEffect(() => {
    scrollRef.current?.scrollToTop();
  }, [resetKey]);

  // Follow mode: scroll to keep followIndex visible
  useEffect(() => {
    if (followIndex !== undefined && scrollRef.current) {
      scrollRef.current.scrollTo(followIndex);
    }
  }, [followIndex]);

  // Keyboard scrolling
  useInput((input, key) => {
    if (!active || followIndex !== undefined) return;
    const sv = scrollRef.current;
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
    <ScrollView ref={scrollRef}>
      {children}
    </ScrollView>
  );
}

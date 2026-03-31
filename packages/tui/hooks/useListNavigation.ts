import { useState, useEffect } from "react";
import { useInput } from "ink";

interface UseListNavigationOpts {
  /** Skip key handling (e.g. when right pane is focused or form is open) */
  active?: boolean;
}

// Number of items to jump per page-up/page-down keypress
const PAGE_SIZE = 20;

/**
 * Reusable list navigation with selection clamping.
 * j/k: move one, f/b or PgDn/PgUp: page, g/G: top/bottom.
 * Every tab's left panel uses this.
 */
export function useListNavigation(length: number, opts?: UseListNavigationOpts) {
  const [sel, setSel] = useState(0);
  const active = opts?.active ?? true;
  const pageSize = PAGE_SIZE;

  // Clamp selection when list shrinks or empties
  useEffect(() => {
    setSel(s => length > 0 ? Math.min(s, length - 1) : 0);
  }, [length]);

  useInput((input, key) => {
    if (!active || length === 0) return;
    const max = length - 1;
    if (input === "j" || key.downArrow) {
      setSel(s => Math.min(s + 1, max));
    } else if (input === "k" || key.upArrow) {
      setSel(s => Math.max(s - 1, 0));
    } else if (input === "f" || key.pageDown) {
      setSel(s => Math.min(s + pageSize, max));
    } else if (input === "b" || key.pageUp) {
      setSel(s => Math.max(s - pageSize, 0));
    } else if (input === "g") {
      setSel(0);
    } else if (input === "G") {
      setSel(max);
    }
  });

  return { sel, setSel };
}

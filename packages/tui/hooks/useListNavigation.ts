import { useState, useEffect } from "react";
import { useInput, useStdout } from "ink";

interface UseListNavigationOpts {
  /** Skip key handling (e.g. when right pane is focused or form is open) */
  active?: boolean;
}

const PAGE_SIZE_RESERVE = 8; // rows reserved for tabs, status bar, events, borders

/**
 * Reusable list navigation with selection clamping.
 * j/k: move one, f/b or PgDn/PgUp: page, g/G: top/bottom.
 * Every tab's left panel uses this.
 */
export function useListNavigation(length: number, opts?: UseListNavigationOpts) {
  const [sel, setSel] = useState(0);
  const active = opts?.active ?? true;
  const { stdout } = useStdout();
  const pageSize = Math.max(1, (stdout?.rows ?? 40) - PAGE_SIZE_RESERVE);

  // Clamp selection when list shrinks (e.g. after deletion)
  useEffect(() => {
    if (length > 0) {
      setSel(s => Math.min(s, length - 1));
    }
  }, [length]);

  useInput((input, key) => {
    if (!active) return;
    if (input === "j" || key.downArrow) {
      setSel(s => Math.min(s + 1, length - 1));
    } else if (input === "k" || key.upArrow) {
      setSel(s => Math.max(s - 1, 0));
    } else if (input === "f" || key.pageDown) {
      setSel(s => Math.min(s + pageSize, length - 1));
    } else if (input === "b" || key.pageUp) {
      setSel(s => Math.max(s - pageSize, 0));
    } else if (input === "g") {
      setSel(0);
    } else if (input === "G") {
      setSel(Math.max(0, length - 1));
    }
  });

  return { sel, setSel };
}

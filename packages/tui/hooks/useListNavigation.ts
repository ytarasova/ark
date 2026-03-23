import { useState, useEffect } from "react";
import { useInput } from "ink";

interface UseListNavigationOpts {
  /** Skip key handling (e.g. when right pane is focused or form is open) */
  active?: boolean;
}

/**
 * Reusable j/k/g/G list navigation with selection clamping.
 * Every tab's left panel uses this.
 */
export function useListNavigation(length: number, opts?: UseListNavigationOpts) {
  const [sel, setSel] = useState(0);
  const active = opts?.active ?? true;

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
    } else if (input === "g") {
      setSel(0);
    } else if (input === "G") {
      setSel(Math.max(0, length - 1));
    }
  });

  return { sel, setSel };
}

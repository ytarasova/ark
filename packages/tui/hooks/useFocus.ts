/**
 * Focus context for keyboard input ownership.
 *
 * Classical UI focus hierarchy: the focused element handles input first.
 * When an overlay/form is active, it owns focus and App-level shortcuts are blocked.
 * Components check `useFocusCheck(id)` before handling input.
 *
 * Focus stack: push when overlay opens, pop when it closes.
 * Top of stack owns input. Empty stack = App-level input active.
 *
 * Each focus entry can optionally specify a target pane ("left" | "right").
 * App.tsx reads `targetPane` to auto-switch the active pane when focus changes.
 * Entries without a pane default to "right" for backward compat (overlays/forms).
 */

import React, { createContext, useContext, useState, useCallback, useMemo } from "react";

interface FocusEntry {
  id: string;
  pane: "left" | "right";
}

interface FocusContextValue {
  /** Push a focus owner onto the stack. pane defaults to "right". */
  push: (id: string, pane?: "left" | "right") => void;
  /** Pop a specific focus owner from the stack */
  pop: (id: string) => void;
  /** Current focus owner (top of stack), or null if App owns focus */
  owner: string | null;
  /** True if no overlay/form owns focus (App-level shortcuts active) */
  appActive: boolean;
  /** Target pane of the current focus owner, or null when stack is empty */
  targetPane: "left" | "right" | null;
}

const FocusContext = createContext<FocusContextValue>({
  push: () => {},
  pop: () => {},
  owner: null,
  appActive: true,
  targetPane: null,
});

export function FocusProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<FocusEntry[]>([]);

  const push = useCallback((id: string, pane: "left" | "right" = "right") => {
    setStack(s => s.some(e => e.id === id) ? s : [...s, { id, pane }]);
  }, []);

  const pop = useCallback((id: string) => {
    setStack(s => s.filter(e => e.id !== id));
  }, []);

  const top = stack.length > 0 ? stack[stack.length - 1] : null;

  const value = useMemo(() => ({
    push,
    pop,
    owner: top?.id ?? null,
    appActive: stack.length === 0,
    targetPane: top?.pane ?? null,
  }), [stack, push, pop]);

  return React.createElement(FocusContext.Provider, { value }, children);
}

/** Get the focus context */
export function useFocus() {
  return useContext(FocusContext);
}

/** Returns true if this component should handle input (it's the current focus owner) */
export function useFocusCheck(id: string): boolean {
  const { owner } = useContext(FocusContext);
  return owner === id;
}

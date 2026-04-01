/**
 * Focus context for keyboard input ownership.
 *
 * Classical UI focus hierarchy: the focused element handles input first.
 * When an overlay/form is active, it owns focus and App-level shortcuts are blocked.
 * Components check `useFocusCheck(id)` before handling input.
 *
 * Focus stack: push when overlay opens, pop when it closes.
 * Top of stack owns input. Empty stack = App-level input active.
 */

import React, { createContext, useContext, useState, useCallback, useMemo } from "react";

interface FocusContextValue {
  /** Push a focus owner onto the stack (e.g. "form", "overlay") */
  push: (id: string) => void;
  /** Pop a specific focus owner from the stack */
  pop: (id: string) => void;
  /** Current focus owner (top of stack), or null if App owns focus */
  owner: string | null;
  /** True if no overlay/form owns focus (App-level shortcuts active) */
  appActive: boolean;
}

const FocusContext = createContext<FocusContextValue>({
  push: () => {},
  pop: () => {},
  owner: null,
  appActive: true,
});

export function FocusProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<string[]>([]);

  const push = useCallback((id: string) => {
    setStack(s => s.includes(id) ? s : [...s, id]);
  }, []);

  const pop = useCallback((id: string) => {
    setStack(s => s.filter(x => x !== id));
  }, []);

  const value = useMemo(() => ({
    push,
    pop,
    owner: stack.length > 0 ? stack[stack.length - 1] : null,
    appActive: stack.length === 0,
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

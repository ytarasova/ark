import React from "react";
import { ScrollBox } from "./ScrollBox.js";

interface DetailPanelProps {
  children: React.ReactNode;
  /** Whether this panel is focused (enables scroll keys) */
  active?: boolean;
  /** When this value changes, scroll resets to the top. */
  resetKey?: string;
}

/**
 * Right-panel wrapper. Provides consistent scrolling behavior
 * across all tabs.
 */
export function DetailPanel({ children, active = false, resetKey }: DetailPanelProps) {
  // panel title+gap (2) + status bar (3) = 5
  return (
    <ScrollBox active={active} resetKey={resetKey}>
      {children}
    </ScrollBox>
  );
}

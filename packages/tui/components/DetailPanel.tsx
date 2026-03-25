import React from "react";
import { ScrollBox } from "./ScrollBox.js";

interface DetailPanelProps {
  children: React.ReactNode;
  /** Whether this panel is focused (enables scroll keys) */
  active?: boolean;
}

/**
 * Right-panel wrapper. Provides consistent scrolling behavior
 * across all tabs.
 */
export function DetailPanel({ children, active = false }: DetailPanelProps) {
  // reserveRows accounts for: tab bar (1) + split pane borders (2) +
  // panel title+gap (2) + event log (2) + status bar (1) + padding (1) = 9
  return (
    <ScrollBox active={active} reserveRows={9}>
      {children}
    </ScrollBox>
  );
}

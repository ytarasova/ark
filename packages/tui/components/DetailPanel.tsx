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
  return (
    <ScrollBox active={active}>
      {children}
    </ScrollBox>
  );
}

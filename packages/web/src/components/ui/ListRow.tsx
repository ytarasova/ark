import * as React from "react";
import { cn } from "../../lib/utils.js";

export interface ListRowProps extends React.HTMLAttributes<HTMLDivElement> {
  selected?: boolean;
  onSelect?: () => void;
  // `role` defaults to "button" for simple clickable rows; override with
  // "option" for listbox contexts (expects ancestor `role="listbox"`).
  role?: "button" | "option";
}

/**
 * Keyboard-accessible list row. Handles Enter / Space activation and sets
 * tabIndex so the row is in the tab order. Use inside rendered lists
 * (FlowsView, AgentsView, ComputeView, etc.) instead of a bare
 * `<div onClick>`, which is screen-reader AND keyboard hostile.
 */
export function ListRow({
  selected,
  onSelect,
  role = "button",
  className,
  onKeyDown,
  children,
  ...rest
}: ListRowProps) {
  return (
    <div
      role={role}
      tabIndex={0}
      aria-selected={role === "option" ? selected : undefined}
      aria-pressed={role === "button" ? selected : undefined}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect?.();
        }
        onKeyDown?.(e);
      }}
      className={cn("cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-1", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

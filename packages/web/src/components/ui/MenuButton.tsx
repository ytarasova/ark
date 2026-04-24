import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { cn } from "../../lib/utils.js";

export interface MenuItem {
  /** Stable id, also used as the data-testid suffix. */
  id: string;
  label: string;
  onSelect: () => void;
  /** When true, renders the item in the destructive color (red). */
  destructive?: boolean;
  /** Disable + dim the row (e.g. while an action is in flight). */
  disabled?: boolean;
}

export interface MenuButtonProps {
  /** Items to render in the popover, top-to-bottom. */
  items: MenuItem[];
  /** Tooltip + aria-label for the trigger. */
  label?: string;
  /** Optional className for the trigger button. */
  triggerClassName?: string;
  /** Optional override for the trigger glyph (defaults to the lucide MoreHorizontal). */
  icon?: React.ReactNode;
}

/**
 * Minimal `...` overflow menu used to collapse low-frequency / state-specific
 * actions out of the SessionHeader action row. Built on radix-dropdown-menu
 * so the popover handles focus, escape, click-outside, and keyboard nav.
 *
 * Visual style mirrors the existing `IconButton` chrome in `SessionHeader`
 * so the trigger sits next to Approve / Stop / Restart without looking like
 * a different control family.
 */
export function MenuButton({ items, label = "More actions", triggerClassName, icon }: MenuButtonProps) {
  if (items.length === 0) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          data-testid="header-actions-overflow"
          className={cn(
            "h-7 w-7 inline-grid place-items-center rounded-[var(--radius-sm)] cursor-pointer",
            "border border-[var(--border)] bg-transparent text-[var(--fg-muted)]",
            "hover:text-[var(--fg)] hover:border-[var(--fg-muted)] transition-colors",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            triggerClassName,
          )}
        >
          {icon ?? <MoreHorizontal size={14} />}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className={cn(
            "min-w-[140px] z-50 p-1 rounded-[var(--radius-sm)]",
            "bg-[var(--bg-popover,var(--bg-card))] border border-[var(--border)]",
            "shadow-[0_4px_16px_rgba(0,0,0,0.35)]",
          )}
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.id}
              data-testid={`header-actions-menu-${item.id}`}
              disabled={item.disabled}
              onSelect={() => item.onSelect()}
              className={cn(
                "flex items-center px-2 py-1.5 rounded-[var(--radius-sm)]",
                "text-[12px] cursor-pointer outline-none select-none",
                "data-[highlighted]:bg-[var(--bg-hover)] data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed",
                item.destructive ? "text-[var(--failed)]" : "text-[var(--fg)]",
              )}
            >
              {item.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

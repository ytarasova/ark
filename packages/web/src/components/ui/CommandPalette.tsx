import { useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "../../lib/utils.js";

export interface CommandItem {
  id: string;
  label: string;
  shortcut?: string;
  icon?: React.ReactNode;
  section?: string;
  onSelect: () => void;
}

export interface CommandPaletteProps extends React.ComponentProps<"div"> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CommandItem[];
  search: string;
  onSearchChange: (value: string) => void;
}

/**
 * Cmd+K overlay with search, actions, navigation, and theme switching.
 * Built on Radix `Dialog` for focus trap, focus restoration, Esc
 * handling, `role="dialog"`, `aria-modal`, and `aria-labelledby`.
 *
 * See `.workflow/audit/8-a11y.md` findings A4 + B7.
 */
export function CommandPalette({
  open,
  onOpenChange,
  items,
  search,
  onSearchChange,
  className,
  ...props
}: CommandPaletteProps) {
  // Cmd+K to toggle -- lives outside the Dialog because it must fire even
  // when the palette is closed.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onOpenChange]);

  const filtered = items.filter((item) => item.label.toLowerCase().includes(search.toLowerCase()));

  // Group by section
  const sections = new Map<string, CommandItem[]>();
  for (const item of filtered) {
    const key = item.section ?? "";
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key)!.push(item);
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-[var(--bg-overlay)]" />
        <Dialog.Content
          className={cn(
            "fixed top-[20%] left-1/2 z-50 -translate-x-1/2 w-full max-w-[560px]",
            "bg-[var(--bg-popover)] border border-[var(--border)] rounded-xl",
            "shadow-[0_16px_48px_rgba(0,0,0,0.3)] overflow-hidden",
            "animate-[fade-in_0.15s_ease-out]",
            "focus:outline-none",
            className,
          )}
          aria-describedby={undefined}
          {...props}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          {/* Search input */}
          <div className="flex items-center px-4 border-b border-[var(--border)]">
            <svg
              className="w-4 h-4 text-[var(--fg-muted)] shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Type a command or search..."
              autoFocus
              aria-label="Search commands"
              className={cn(
                "flex-1 h-12 px-3 text-[14px] text-[var(--fg)] bg-transparent",
                "focus:outline-none focus-visible:outline-none",
                "placeholder:text-[var(--fg-faint)]",
              )}
            />
            <kbd className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--bg-card)] text-[var(--fg-muted)]">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div className="max-h-[320px] overflow-y-auto py-2">
            {[...sections.entries()].map(([section, sectionItems]) => (
              <div key={section}>
                {section && (
                  <div className="px-4 pt-2 pb-1 text-[10px] font-medium uppercase tracking-[0.04em] text-[var(--fg-faint)]">
                    {section}
                  </div>
                )}
                {sectionItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      item.onSelect();
                      onOpenChange(false);
                    }}
                    className={cn(
                      "flex items-center gap-3 w-full px-4 py-2 text-left text-[13px]",
                      "text-[var(--fg)] hover:bg-[var(--bg-hover)] cursor-pointer bg-transparent border-none",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-inset",
                      "transition-colors duration-100",
                    )}
                  >
                    {item.icon && <span className="w-4 h-4 shrink-0 text-[var(--fg-muted)]">{item.icon}</span>}
                    <span className="flex-1">{item.label}</span>
                    {item.shortcut && (
                      <kbd className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--bg-card)] text-[var(--fg-muted)]">
                        {item.shortcut}
                      </kbd>
                    )}
                  </button>
                ))}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="px-4 py-8 text-center text-[13px] text-[var(--fg-muted)]">No results found</div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

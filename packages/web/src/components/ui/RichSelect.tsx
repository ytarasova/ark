import { useState, useRef, useEffect } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "../../lib/utils.js";

export interface RichSelectOption {
  value: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  badge?: string;
}

export interface RichSelectProps {
  options: RichSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  className?: string;
  searchable?: boolean;
  disabled?: boolean;
}

const triggerClass = cn(
  "flex items-center justify-between w-full h-9 px-3 rounded-md",
  "border border-[var(--border)] bg-[var(--bg,transparent)] text-[var(--fg,var(--foreground))] text-[13px]",
  "hover:border-[var(--fg-muted,hsl(var(--muted-foreground)))] transition-colors duration-150 cursor-pointer",
  "outline-none focus:ring-2 focus:ring-[var(--primary,hsl(var(--ring)))]",
);

const contentClass = cn(
  "w-[var(--radix-popover-trigger-width)] max-h-[300px] overflow-y-auto",
  "rounded-md border border-[var(--border)] bg-[var(--bg-card,var(--bg,hsl(var(--card))))] shadow-lg",
  "p-1 z-50",
);

export function RichSelect({
  options,
  value,
  onChange,
  placeholder = "Select...",
  className,
  searchable,
  disabled,
}: RichSelectProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const current = options.find((o) => o.value === value);

  // Auto-enable search for long lists
  const showSearch = searchable ?? options.length > 6;

  useEffect(() => {
    if (open && showSearch) {
      // Small delay so the popover renders first
      const t = setTimeout(() => filterRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
    if (!open) setFilter("");
  }, [open, showSearch]);

  const filtered = filter
    ? options.filter(
        (o) =>
          o.label.toLowerCase().includes(filter.toLowerCase()) ||
          (o.description && o.description.toLowerCase().includes(filter.toLowerCase())),
      )
    : options;

  return (
    <Popover.Root open={open} onOpenChange={disabled ? undefined : setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(triggerClass, disabled && "opacity-50 cursor-not-allowed", className)}
          disabled={disabled}
        >
          <span className="truncate text-left flex-1">
            {current ? (
              <>
                <span className="font-medium">{current.label}</span>
                {current.description && (
                  <span className="text-[var(--fg-muted,hsl(var(--muted-foreground)))] ml-1.5 text-[12px]">
                    -- {current.description}
                  </span>
                )}
              </>
            ) : (
              <span className="text-[var(--fg-muted,hsl(var(--muted-foreground)))]">{placeholder}</span>
            )}
          </span>
          <ChevronDown size={14} className="text-[var(--fg-muted,hsl(var(--muted-foreground)))] shrink-0 ml-2" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={4} align="start" className={contentClass}>
          {showSearch && (
            <div className="px-1.5 pb-1.5 pt-0.5">
              <div className="relative">
                <Search
                  size={12}
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--fg-muted,hsl(var(--muted-foreground)))]"
                />
                <input
                  ref={filterRef}
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter..."
                  className={cn(
                    "w-full h-7 pl-6 pr-2 text-[12px] rounded-[var(--radius-sm,4px)]",
                    "bg-[var(--bg,transparent)] border border-[var(--border)] text-[var(--fg,var(--foreground))]",
                    "outline-none focus:ring-1 focus:ring-[var(--primary,hsl(var(--ring)))]",
                    "placeholder:text-[var(--fg-muted,hsl(var(--muted-foreground)))]",
                  )}
                />
              </div>
            </div>
          )}
          {filtered.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={cn(
                "flex items-start gap-2 w-full text-left px-2.5 py-2 rounded-[var(--radius-sm,4px)]",
                "hover:bg-[var(--bg-hover,hsl(var(--accent)))] transition-colors duration-100 cursor-pointer",
                value === o.value && "bg-[var(--primary)]/5",
              )}
            >
              <div className="w-4 pt-0.5 shrink-0">
                {value === o.value && <Check size={14} className="text-[var(--primary,hsl(var(--primary)))]" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {o.icon && <span className="shrink-0">{o.icon}</span>}
                  <span className="text-[13px] font-medium text-[var(--fg,var(--foreground))]">{o.label}</span>
                  {o.badge && (
                    <span className="text-[10px] px-1.5 py-0 rounded-full bg-[var(--bg-hover,hsl(var(--secondary)))] text-[var(--fg-muted,hsl(var(--muted-foreground)))] font-mono">
                      {o.badge}
                    </span>
                  )}
                </div>
                {o.description && (
                  <div className="text-[12px] text-[var(--fg-muted,hsl(var(--muted-foreground)))] mt-0.5 line-clamp-2">
                    {o.description}
                  </div>
                )}
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-3 py-4 text-[12px] text-[var(--fg-muted,hsl(var(--muted-foreground)))] text-center">
              {filter ? "No matches" : "No options available"}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

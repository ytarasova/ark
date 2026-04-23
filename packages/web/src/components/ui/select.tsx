import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils.js";

/**
 * Select atom -- per /tmp/ark-design-system/preview/form-input-select.html
 *
 * Looks exactly like Input: h-32 rounded-6 inset bg + border. Chevron at the
 * trailing edge, optional leading mono chip. Renders a popover anchored below
 * on click; options have a left primary bar when selected.
 */

export interface SelectOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  meta?: React.ReactNode;
  section?: string;
  pip?: boolean;
}

export interface SelectProps<T extends string = string> {
  value?: T;
  onChange?: (value: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  leading?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  /** Show a search box at the top of the popover. */
  searchable?: boolean;
}

export function Select<T extends string = string>({
  value,
  onChange,
  options,
  placeholder = "select...",
  leading,
  disabled,
  className,
  searchable,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const filtered =
    searchable && query ? options.filter((o) => String(o.label).toLowerCase().includes(query.toLowerCase())) : options;

  // group by section
  const groups: Array<{ section?: string; items: SelectOption<T>[] }> = [];
  for (const opt of filtered) {
    const last = groups[groups.length - 1];
    if (last && last.section === opt.section) last.items.push(opt);
    else groups.push({ section: opt.section, items: [opt] });
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className={cn(
          "flex items-center gap-[8px] h-[32px] w-full px-[11px] rounded-[6px] text-left cursor-pointer",
          "bg-[#0a0a12] border border-[var(--border)]",
          "shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_1px_0_rgba(255,255,255,0.02)]",
          "transition-[border-color,background,box-shadow] duration-[120ms]",
          "hover:border-[#33334d] hover:bg-[#0d0d18]",
          open && [
            "border-[var(--primary)] bg-[#0d0d18]",
            "shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_0_0_3px_rgba(107,89,222,0.18)]",
          ],
          disabled && "opacity-50 cursor-not-allowed",
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {leading && (
          <span className="text-[var(--fg-faint)] text-[10px] font-medium uppercase tracking-[0.04em] shrink-0 font-[family-name:var(--font-mono-ui)] pr-[8px] border-r border-[var(--border)]">
            {leading}
          </span>
        )}
        <span
          className={cn(
            "flex-1 min-w-0 flex items-baseline gap-[8px] overflow-hidden whitespace-nowrap text-ellipsis",
            "font-[family-name:var(--font-sans)] text-[12px] tracking-[-0.005em]",
            selected ? "text-[var(--fg)] font-medium" : "text-[var(--fg-faint)] font-normal",
          )}
        >
          {selected ? (
            <>
              {selected.pip && (
                <span
                  aria-hidden
                  className="inline-block w-[6px] h-[6px] rounded-full bg-[var(--completed)] shadow-[0_0_4px_rgba(52,211,153,0.5)] shrink-0"
                />
              )}
              <span className="truncate">{selected.label}</span>
              {selected.meta && (
                <em className="not-italic text-[var(--fg-faint)] font-normal text-[10px] font-[family-name:var(--font-mono-ui)] uppercase tracking-[0.04em] shrink-0">
                  {selected.meta}
                </em>
              )}
            </>
          ) : (
            placeholder
          )}
        </span>
        <span className="text-[var(--fg-muted)] font-[family-name:var(--font-mono)] text-[12px] shrink-0" aria-hidden>
          {open ? "▴" : "▾"}
        </span>
      </button>

      {open && (
        <div
          className={cn(
            "absolute left-0 right-0 mt-[6px] z-50 rounded-[6px] overflow-hidden",
            "bg-[var(--bg-popover)] border border-[var(--border)]",
            "shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_8px_20px_-4px_rgba(0,0,0,0.5),0_2px_4px_rgba(0,0,0,0.4)]",
            "max-h-[280px] flex flex-col",
          )}
          role="listbox"
        >
          {searchable && (
            <div className="px-[11px] py-[8px] border-b border-[var(--border)] flex items-center gap-[8px] text-[var(--fg-faint)]">
              <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20 16.5 16.5" strokeLinecap="round" />
              </svg>
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="filter..."
                className="flex-1 min-w-0 bg-transparent border-0 outline-none font-[family-name:var(--font-sans)] text-[12px] text-[var(--fg)] placeholder:text-[var(--fg-faint)]"
              />
            </div>
          )}
          <div className="overflow-auto">
            {groups.map((g, gi) => (
              <div key={gi}>
                {g.section && (
                  <div className="px-[11px] py-[4px] font-[family-name:var(--font-mono-ui)] text-[9px] font-medium uppercase tracking-[0.06em] text-[var(--fg-faint)] bg-[rgba(0,0,0,0.15)] border-y border-[var(--border)]">
                    {g.section}
                  </div>
                )}
                {g.items.map((opt) => {
                  const sel = opt.value === value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="option"
                      aria-selected={sel}
                      onClick={() => {
                        onChange?.(opt.value);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex items-center gap-[8px] w-full text-left px-[11px] py-[7px]",
                        "font-[family-name:var(--font-sans)] text-[12px] font-medium text-[var(--fg)] cursor-pointer",
                        "hover:bg-[var(--bg-hover)]",
                        sel && "bg-[rgba(107,89,222,0.12)] border-l-[2px] border-l-[var(--primary)] pl-[9px]",
                      )}
                    >
                      {opt.pip && (
                        <span className="w-[6px] h-[6px] rounded-full bg-[var(--completed)] shadow-[0_0_4px_rgba(52,211,153,0.5)]" />
                      )}
                      <span className="truncate">{opt.label}</span>
                      {opt.meta && (
                        <span className="ml-auto font-[family-name:var(--font-mono-ui)] text-[10px] font-normal uppercase tracking-[0.04em] text-[var(--fg-faint)] shrink-0">
                          {opt.meta}
                        </span>
                      )}
                      {sel && !opt.meta && (
                        <span className="ml-auto text-[var(--primary)]" aria-hidden>
                          <svg
                            viewBox="0 0 24 24"
                            width={12}
                            height={12}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2.5}
                          >
                            <polyline points="20 6 9 17 4 12" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="px-[11px] py-[10px] font-[family-name:var(--font-mono-ui)] text-[10px] uppercase tracking-[0.04em] text-[var(--fg-faint)]">
                no matches
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

import { cn } from "../../lib/utils.js";

export interface IconRailItem {
  id: string;
  icon: React.ReactNode;
  label: string;
}

export interface IconRailProps extends React.ComponentProps<"nav"> {
  items: IconRailItem[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Settings item pinned to the bottom */
  settingsItem?: IconRailItem;
  /** Optional brand logo node */
  logo?: React.ReactNode;
}

/**
 * 48px-wide left icon navigation rail.
 * Icons for sessions/agents/flows/compute/costs + settings at bottom.
 */
export function IconRail({ items, activeId, onSelect, settingsItem, logo, className, ...props }: IconRailProps) {
  return (
    <nav
      className={cn(
        "w-16 min-w-16 bg-[var(--bg-sidebar)] border-r border-[var(--border)]",
        "flex flex-col items-center py-3 gap-0.5",
        className,
      )}
      aria-label="Main navigation"
      {...props}
    >
      {/* Logo */}
      {logo ?? (
        <div
          className={cn(
            "w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center",
            "mb-4 font-bold text-[12px] text-white cursor-pointer",
          )}
          style={{ background: "var(--gradient-brand)" }}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(items[0]?.id ?? "sessions")}
          onKeyDown={(e) => e.key === "Enter" && onSelect(items[0]?.id ?? "sessions")}
          aria-label="Home"
        >
          A
        </div>
      )}

      {/* Nav items */}
      {items.map((item) => (
        <RailButton key={item.id} item={item} active={activeId === item.id} onSelect={onSelect} />
      ))}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Settings */}
      {settingsItem && <RailButton item={settingsItem} active={activeId === settingsItem.id} onSelect={onSelect} />}
    </nav>
  );
}

function RailButton({
  item,
  active,
  onSelect,
}: {
  item: IconRailItem;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      title={item.label}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "w-9 h-9 rounded-lg border-none flex items-center justify-center cursor-pointer relative",
        "text-[var(--fg-muted)] bg-transparent transition-colors duration-150",
        "[&_svg]:w-[18px] [&_svg]:h-[18px] [&_svg]:stroke-[1.5]",
        "hover:text-[var(--fg)] hover:bg-[var(--bg-hover)]",
        active && "text-[var(--primary)] bg-[var(--primary-subtle)]",
      )}
    >
      {/* Active indicator bar */}
      {active && (
        <span className="absolute left-[-6px] top-2 bottom-2 w-[3px] rounded-r bg-[var(--primary)]" aria-hidden />
      )}
      {item.icon}
    </button>
  );
}

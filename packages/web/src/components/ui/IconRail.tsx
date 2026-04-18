import { cn } from "../../lib/utils.js";
import type { DaemonStatus } from "../../hooks/useDaemonStatus.js";

export interface IconRailItem {
  id: string;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}

export interface IconRailProps extends React.ComponentProps<"nav"> {
  items: IconRailItem[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Settings item pinned to the bottom */
  settingsItem?: IconRailItem;
  /** Optional brand logo node */
  logo?: React.ReactNode;
  /** Daemon health status -- drives the status dot on the logo */
  daemonStatus?: DaemonStatus | null;
}

/**
 * 48px-wide left icon navigation rail.
 * Icons for sessions/agents/flows/compute/costs + settings at bottom.
 */
/** Derive a status dot color + tooltip from daemon probe results. */
function getDaemonDot(ds: DaemonStatus | null | undefined): { color: string; title: string; status: string } {
  if (!ds) return { color: "bg-gray-500/40", title: "Checking daemons...", status: "loading" };
  const { conductor, arkd } = ds;
  if (conductor.online && arkd.online)
    return { color: "bg-green-500", title: "Conductor and arkd online", status: "online" };
  if (conductor.online || arkd.online) {
    return {
      color: "bg-yellow-500",
      title: `${conductor.online ? "Conductor" : "arkd"} online, ${conductor.online ? "arkd" : "conductor"} offline`,
      status: "partial",
    };
  }
  return { color: "bg-red-500", title: "Daemon offline -- run: ark server daemon start", status: "offline" };
}

export function IconRail({
  items,
  activeId,
  onSelect,
  settingsItem,
  logo,
  daemonStatus,
  className,
  ...props
}: IconRailProps) {
  const dot = getDaemonDot(daemonStatus);
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
        <div className="relative mb-4">
          <div
            data-testid="sidebar-brand"
            className={cn(
              "w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center",
              "font-bold text-[12px] text-white cursor-pointer",
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
          <span
            data-testid="daemon-status-dot"
            data-status={dot.status}
            className={cn(
              "absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-[var(--bg-sidebar)]",
              dot.color,
            )}
            title={dot.title}
          />
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
        "w-14 py-1.5 rounded-lg border-none flex flex-col items-center justify-center gap-0.5 cursor-pointer relative",
        "text-[var(--fg-muted)] bg-transparent transition-colors duration-150",
        "[&_svg]:w-[20px] [&_svg]:h-[20px] [&_svg]:stroke-[1.5]",
        "hover:text-[var(--fg)] hover:bg-[var(--bg-hover)]",
        active && "text-[var(--primary)] bg-[var(--primary-subtle)]",
      )}
    >
      {/* Active indicator bar */}
      {active && (
        <span className="absolute left-[-6px] top-1 bottom-1 w-[3px] rounded-r bg-[var(--primary)]" aria-hidden />
      )}
      {/* Unread dot */}
      {item.badge != null && item.badge > 0 && (
        <span
          className="absolute top-0.5 right-1 w-2 h-2 rounded-full bg-red-500 animate-pulse"
          aria-label="has unread messages"
        />
      )}
      {item.icon}
      <span className="text-[9px] leading-tight truncate w-full text-center">{item.label}</span>
    </button>
  );
}

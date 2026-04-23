import { cn } from "../../lib/utils.js";
import type { DaemonStatus } from "../../hooks/useDaemonStatus.js";

export interface IconRailItem {
  id: string;
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  badge?: number;
  /** Small failure dot at the corner (used for Router health, etc.). */
  alertDot?: boolean;
}

export interface IconRailProps extends React.ComponentProps<"nav"> {
  items: IconRailItem[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Settings item pinned to the bottom. */
  settingsItem?: IconRailItem;
  /** Optional brand logo node. */
  logo?: React.ReactNode;
  /** Daemon health status -- drives the brand live dot + foot-line latency. */
  daemonStatus?: DaemonStatus | null;
  /** Avatar initials for the pinned avatar button (bottom). */
  avatarInitials?: string;
  /** Optional latency text to render in the foot row (e.g. "18ms"). */
  latencyText?: string;
}

/**
 * Icon rail -- rebuilt from `/tmp/ark-design-system/preview/chrome-sidebar.html`.
 *
 * Geometry (canonical per chrome-sidebar.html):
 *   rail width       60px FIXED
 *   brand block      36x36 r8, gradient-brand, mono 15px bold.
 *                    Live dot 6px top-right, running-color, 2.5s glow.
 *   nav item         36x36 r7. default fg-muted.
 *                    hover: fg + bg-hover.
 *                    active: fg + primary-subtle bg +
 *                            left-glow bar (2px x (h-16px)).
 *   separator        24px x 1px, var(--border), my-6.
 *   icon glyph       18px, stroke 1.75, currentColor.
 *   settings row     36x36 r7 (same as nav).
 *   avatar           32x32 r99, amber->pink gradient, 12px mono initials,
 *                    2px border bg-sidebar, presence dot 9px br.
 *   foot             18px, 9px mono-ui fg-faint, border-top rgba255,04.
 *
 * Hover tooltips appear as pills to the right of each icon using native CSS.
 */
function getDaemonDot(ds: DaemonStatus | null | undefined): {
  color: string;
  glow: string;
  title: string;
  status: string;
} {
  if (!ds) return { color: "bg-[var(--stopped)]", glow: "", title: "Checking daemons…", status: "loading" };
  const { conductor, arkd } = ds;
  if (conductor.online && arkd.online) {
    return {
      color: "bg-[var(--completed)]",
      glow: "shadow-[0_0_6px_rgba(52,211,153,0.8)]",
      title: "Conductor + arkd online",
      status: "online",
    };
  }
  if (conductor.online || arkd.online) {
    return {
      color: "bg-[var(--waiting)]",
      glow: "",
      title: `${conductor.online ? "Conductor" : "arkd"} online, ${conductor.online ? "arkd" : "conductor"} offline`,
      status: "partial",
    };
  }
  return {
    color: "bg-[var(--failed)]",
    glow: "shadow-[var(--failed-glow)]",
    title: "Daemon offline -- run: ark server daemon start",
    status: "offline",
  };
}

export function IconRail({
  items,
  activeId,
  onSelect,
  settingsItem,
  logo,
  daemonStatus,
  avatarInitials,
  latencyText,
  className,
  ...props
}: IconRailProps) {
  const dot = getDaemonDot(daemonStatus);
  const latencyOk = dot.status === "online";
  return (
    <nav
      className={cn(
        "w-[60px] min-w-[60px] h-full",
        "bg-[var(--bg-sidebar)] border-r border-[var(--border)]",
        "flex flex-col items-center relative",
        className,
      )}
      aria-label="Main navigation"
      {...props}
    >
      {/* Brand block ----------------------------------------------------- */}
      {logo ?? (
        <div className="relative w-full h-[56px] flex items-center justify-center drag-region shrink-0">
          <button
            type="button"
            data-testid="sidebar-brand"
            onClick={() => onSelect(items[0]?.id ?? "sessions")}
            aria-label="Home"
            className={cn(
              "no-drag w-[36px] h-[36px] rounded-[8px] grid place-items-center cursor-pointer",
              "bg-[var(--gradient-brand,var(--primary))] text-white",
              "shadow-[0_2px_6px_rgba(107,89,222,0.4),inset_0_0_0_1px_rgba(255,255,255,0.1)]",
              "font-bold text-[15px] font-[family-name:var(--font-mono-ui)]",
            )}
            style={{ backgroundImage: "var(--gradient-brand)", backgroundColor: "var(--primary)" }}
          >
            A
          </button>
          <span
            data-testid="daemon-status-dot"
            data-status={dot.status}
            title={dot.title}
            className={cn(
              "absolute top-[14px] right-[10px] w-[6px] h-[6px] rounded-full",
              dot.color,
              dot.glow,
              dot.status === "online" && "animate-[brandGlow_2.5s_ease-in-out_infinite]",
            )}
          />
        </div>
      )}

      {/* Nav items (scrollable) ------------------------------------------ */}
      <div className="flex-1 min-h-0 w-full overflow-y-auto overflow-x-hidden py-[4px] flex flex-col items-center gap-[4px] no-scrollbar">
        {items.map((item) => (
          <RailButton key={item.id} item={item} active={activeId === item.id} onSelect={onSelect} />
        ))}
      </div>

      {/* Settings + avatar (pinned bottom) -------------------------------- */}
      <div className="flex flex-col items-center gap-[4px] pb-[10px] pt-[6px] w-full border-t border-[rgba(255,255,255,0.04)] shrink-0">
        {settingsItem && <RailButton item={settingsItem} active={activeId === settingsItem.id} onSelect={onSelect} />}
        {avatarInitials && (
          <div
            className="relative w-[32px] h-[32px] mt-[2px] rounded-full grid place-items-center border-[2px] border-[var(--bg-sidebar)] text-white font-semibold text-[12px] font-[family-name:var(--font-mono-ui)]"
            style={{ backgroundImage: "linear-gradient(135deg, #f59e0b, #ec4899)" }}
            title={avatarInitials}
          >
            {avatarInitials}
            <span
              aria-hidden
              className="absolute -bottom-[1px] -right-[1px] w-[9px] h-[9px] rounded-full bg-[var(--completed)] shadow-[0_0_0_2px_var(--bg-sidebar),0_0_4px_rgba(52,211,153,0.6)]"
            />
          </div>
        )}
      </div>

      {/* Foot ------------------------------------------------------------- */}
      <div
        className={cn(
          "h-[18px] flex items-center justify-center gap-[3px] shrink-0",
          "font-[family-name:var(--font-mono-ui)] text-[9px] font-normal text-[var(--fg-faint)]",
          "border-t border-[rgba(255,255,255,0.04)] bg-[rgba(0,0,0,0.2)]",
        )}
      >
        {latencyText ? (
          <>
            <i
              className={cn(
                "w-[4px] h-[4px] rounded-full",
                latencyOk ? "bg-[var(--completed)] shadow-[0_0_3px_var(--completed)]" : "bg-[var(--failed)]",
              )}
            />
            {latencyText}
          </>
        ) : (
          <span className="opacity-60">{dot.status === "online" ? "online" : "offline"}</span>
        )}
      </div>
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
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center justify-center cursor-pointer",
        "bg-transparent border-0 text-[var(--fg-muted)] transition-colors duration-[120ms]",
        "w-[36px] h-[36px] rounded-[7px]",
        "[&_svg]:w-[18px] [&_svg]:h-[18px] [&_svg]:stroke-[1.75] [&_svg]:transition-colors",
        "hover:text-[var(--fg)] hover:bg-[var(--bg-hover)]",
        active && ["text-[var(--fg)]", "bg-[var(--primary-subtle)]"],
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-[-12px] top-[8px] bottom-[8px] w-[2px] rounded-r-[2px] bg-[var(--primary)] shadow-[0_0_6px_rgba(107,89,222,0.6)]"
        />
      )}
      {item.icon}
      {item.badge != null && item.badge > 0 && (
        <span
          aria-label={`${item.badge} unread`}
          className="absolute -top-[3px] -right-[4px] min-w-[15px] h-[15px] px-[4px] rounded-full grid place-items-center bg-[var(--primary)] text-white text-[9px] font-semibold font-[family-name:var(--font-mono-ui)] shadow-[0_0_0_2px_var(--bg-sidebar),0_1px_2px_rgba(0,0,0,0.4)]"
        >
          {item.badge > 99 ? "99+" : item.badge}
        </span>
      )}
      {item.alertDot && (
        <span className="absolute top-[4px] right-[4px] w-[7px] h-[7px] rounded-full bg-[var(--failed)] shadow-[0_0_0_2px_var(--bg-sidebar),0_0_4px_rgba(248,113,113,0.6)]" />
      )}
      <span
        aria-hidden
        className={cn(
          "absolute left-[calc(100%+10px)] top-1/2 -translate-y-1/2 z-50",
          "px-[8px] py-[4px] rounded-[5px]",
          "bg-[#26263c] text-[var(--fg)] font-[family-name:var(--font-sans)] text-[11px] font-medium whitespace-nowrap",
          "border border-[var(--border)] shadow-[0_4px_12px_rgba(0,0,0,0.5)]",
          "opacity-0 pointer-events-none transition-opacity duration-[120ms] group-hover:opacity-100",
          "flex items-center gap-[6px]",
        )}
      >
        {item.label}
        {item.shortcut && (
          <kbd className="px-[4px] py-[1px] rounded-[3px] bg-[rgba(0,0,0,0.3)] text-[var(--fg-muted)] text-[10px] font-medium font-[family-name:var(--font-mono-ui)] border border-[var(--border)]">
            {item.shortcut}
          </kbd>
        )}
      </span>
    </button>
  );
}

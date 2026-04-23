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
 * Icon rail — rebuilt from `/tmp/ark-design-system/preview/app-chrome.html`.
 *
 * Geometry:
 *   rail width       52px
 *   brand block      height 40px, logo 30x30 r7, primary fill, border
 *                    rgba(0,0,0,.25), shadow 0 1px 2px rgba(0,0,0,.25).
 *                    Live dot 6px at top-8/right-9, running-color, 2.5s glow.
 *   nav item         40x32 r7.   default fg-muted + svg opacity .75.
 *                    hover: fg + rgba(255,255,255,.04) bg.
 *                    active: fg + rgba(107,89,222,.12) bg + primary-color svg
 *                            + 0 0 0 1px rgba(107,89,222,.3) outline +
 *                            left-glow bar (2.5px × 16px).
 *   separator        28px × 1px, rgba(255,255,255,.05), my-4.
 *   settings row     32x28 r6.
 *   avatar           26x26 r99, primary fill, mono 10px initials.
 *   foot             18px, 9px mono-ui fg-faint, border-top 1/rgba255,04.
 *
 * Hover tooltips appear as 26px-tall pills to the right of each icon; the old
 * implementation relied on `<Tooltip>` from radix which added ms latency and
 * blocked the pixel-precise look. The preview uses native CSS positioning.
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
        "w-[52px] min-w-[52px] h-full",
        "bg-[var(--bg-sidebar)] border-r border-[var(--border)]",
        "flex flex-col relative",
        className,
      )}
      aria-label="Main navigation"
      {...props}
    >
      {/* Brand block ----------------------------------------------------- */}
      {logo ?? (
        <div className="relative h-[40px] flex items-center justify-center border-b border-[rgba(255,255,255,0.03)] drag-region">
          <button
            type="button"
            data-testid="sidebar-brand"
            onClick={() => onSelect(items[0]?.id ?? "sessions")}
            aria-label="Home"
            className={cn(
              "no-drag w-[30px] h-[30px] rounded-[7px] grid place-items-center cursor-pointer",
              "bg-[var(--primary)] text-white",
              "border border-[rgba(0,0,0,0.25)] shadow-[0_1px_2px_rgba(0,0,0,0.25)]",
              "font-extrabold text-[14px] tracking-[-0.05em]",
            )}
          >
            a
          </button>
          <span
            data-testid="daemon-status-dot"
            data-status={dot.status}
            title={dot.title}
            className={cn(
              "absolute top-[8px] right-[9px] w-[6px] h-[6px] rounded-full",
              dot.color,
              dot.glow,
              dot.status === "online" && "animate-[brandGlow_2.5s_ease-in-out_infinite]",
            )}
          />
        </div>
      )}

      {/* Nav items (scrollable) ------------------------------------------ */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden py-[6px] flex flex-col items-center gap-[2px] no-scrollbar">
        {items.map((item) => (
          <RailButton key={item.id} item={item} active={activeId === item.id} onSelect={onSelect} />
        ))}
      </div>

      {/* Settings + avatar (pinned bottom) -------------------------------- */}
      <div className="flex flex-col items-center gap-[2px] py-[2px] border-t border-[rgba(255,255,255,0.04)] shrink-0">
        {settingsItem && <RailButton item={settingsItem} active={activeId === settingsItem.id} onSelect={onSelect} settings />}
        {avatarInitials && (
          <div
            className="w-[26px] h-[26px] my-[3px] rounded-full grid place-items-center border border-[rgba(0,0,0,0.25)] shadow-[0_1px_2px_rgba(0,0,0,0.2)] bg-[var(--primary)] text-white font-semibold text-[10px] font-[family-name:var(--font-mono-ui)]"
            title={avatarInitials}
          >
            {avatarInitials}
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
  settings,
}: {
  item: IconRailItem;
  active: boolean;
  onSelect: (id: string) => void;
  settings?: boolean;
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
        settings
          ? "w-[32px] h-[28px] rounded-[6px]"
          : "w-[40px] h-[32px] rounded-[7px]",
        "[&_svg]:w-[15px] [&_svg]:h-[15px] [&_svg]:opacity-[.75] [&_svg]:transition-opacity",
        "hover:text-[var(--fg)] hover:bg-[rgba(255,255,255,0.04)] hover:[&_svg]:opacity-100",
        active && [
          "text-[var(--fg)]",
          "bg-[rgba(107,89,222,0.12)]",
          "shadow-[0_0_0_1px_rgba(107,89,222,0.3)]",
          "[&_svg]:opacity-100 [&_svg]:!text-[var(--primary)]",
        ],
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-[-6px] top-[8px] bottom-[8px] w-[2.5px] rounded-r-[3px] bg-[var(--primary)] shadow-[0_0_6px_rgba(107,89,222,0.6)]"
        />
      )}
      {item.icon}
      {item.badge != null && item.badge > 0 && (
        <span
          aria-label={`${item.badge} unread`}
          className="absolute top-[2px] right-[5px] min-w-[13px] h-[13px] px-[3px] rounded-full grid place-items-center bg-[var(--primary)] text-white text-[9px] font-semibold font-[family-name:var(--font-mono-ui)]"
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

import { useEffect, useMemo } from "react";
import { IconRail } from "./ui/IconRail.js";
import type { IconRailItem } from "./ui/IconRail.js";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";
import { Play, Bot, Zap, Monitor, Clock, BookOpen, DollarSign, Cog, Wrench, Calendar, Plug } from "lucide-react";

interface LayoutProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
  /** Middle column -- persistent 268px session list (or other context list). */
  list?: React.ReactNode;
  /** Main pane. */
  children: React.ReactNode;
  /** Total unread message count to badge on Sessions icon. */
  totalUnread?: number;
  /** Current user avatar initials. */
  avatarInitials?: string;
  /** Foot text (daemon latency etc.). */
  latencyText?: string;
}

const BASE_NAV_ITEMS: IconRailItem[] = [
  { id: "sessions", icon: <Play size={15} strokeWidth={1.5} />, label: "Sessions", shortcut: "S" },
  { id: "agents", icon: <Bot size={15} strokeWidth={1.5} />, label: "Agents", shortcut: "A" },
  { id: "flows", icon: <Zap size={15} strokeWidth={1.5} />, label: "Flows", shortcut: "F" },
  { id: "compute", icon: <Monitor size={15} strokeWidth={1.5} />, label: "Compute", shortcut: "C" },
  { id: "history", icon: <Clock size={15} strokeWidth={1.5} />, label: "History", shortcut: "H" },
  { id: "memory", icon: <BookOpen size={15} strokeWidth={1.5} />, label: "Knowledge", shortcut: "M" },
  { id: "tools", icon: <Wrench size={15} strokeWidth={1.5} />, label: "Tools", shortcut: "T" },
  { id: "schedules", icon: <Calendar size={15} strokeWidth={1.5} />, label: "Schedules" },
  { id: "integrations", icon: <Plug size={15} strokeWidth={1.5} />, label: "Integrations", shortcut: "I" },
  { id: "costs", icon: <DollarSign size={15} strokeWidth={1.5} />, label: "Costs", shortcut: "$" },
];

const SETTINGS_ITEM: IconRailItem = { id: "settings", icon: <Cog size={15} strokeWidth={1.5} />, label: "Settings", shortcut: "," };

const SHORTCUTS: Record<string, string> = {
  s: "sessions",
  a: "agents",
  f: "flows",
  c: "compute",
  h: "history",
  m: "memory",
  t: "tools",
  i: "integrations",
  $: "costs",
  ",": "settings",
};

/**
 * Layout -- 3-column chrome from `/tmp/ark-design-system/preview/app-chrome.html`.
 *
 *   grid-template-columns: 52px 268px 1fr
 *
 * The 52px icon rail is always mounted. The 268px middle column (session list
 * or other context panel) is mounted when `list` is non-null; callers that
 * don't need a context column (e.g. Settings, Admin) can omit it and the grid
 * collapses to `52px 1fr`.
 */
export function Layout({
  view,
  onNavigate,
  daemonStatus,
  list,
  children,
  totalUnread,
  avatarInitials,
  latencyText,
}: LayoutProps) {
  const navItems = useMemo(() => {
    if (!totalUnread) return BASE_NAV_ITEMS;
    return BASE_NAV_ITEMS.map((item) => (item.id === "sessions" ? { ...item, badge: totalUnread } : item));
  }, [totalUnread]);

  // Keyboard shortcuts for navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      const active = document.activeElement as HTMLElement | null;
      const el = target ?? active;
      if (el) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
        if (el.isContentEditable) return;
        const role = el.getAttribute?.("role");
        if (role === "textbox" || role === "combobox" || role === "searchbox") return;
      }

      const key = e.key.toLowerCase();
      const dest = SHORTCUTS[key] || SHORTCUTS[e.key];
      if (dest) {
        e.preventDefault();
        onNavigate(dest);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onNavigate]);

  return (
    <div
      className="h-screen bg-[var(--bg)] overflow-hidden"
      style={{
        display: "grid",
        gridTemplateColumns: list ? "52px 268px 1fr" : "52px 1fr",
      }}
    >
      <IconRail
        items={navItems}
        activeId={view}
        onSelect={onNavigate}
        settingsItem={SETTINGS_ITEM}
        daemonStatus={daemonStatus}
        avatarInitials={avatarInitials}
        latencyText={latencyText}
      />
      {list && (
        <aside
          className="h-full min-w-0 overflow-hidden flex flex-col border-r border-[var(--border)] bg-[var(--bg)]"
          aria-label="Session list"
        >
          {list}
        </aside>
      )}
      <main id="main" className="h-full min-w-0 overflow-hidden flex flex-col">
        {children}
      </main>
    </div>
  );
}

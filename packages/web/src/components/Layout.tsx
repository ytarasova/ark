import { useEffect, useMemo } from "react";
import { IconRail } from "./ui/IconRail.js";
import type { IconRailItem } from "./ui/IconRail.js";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";
import { Play, Bot, Zap, Monitor, Clock, BookOpen, DollarSign, Cog, Wrench, Calendar } from "lucide-react";

interface LayoutProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  daemonStatus?: DaemonStatus | null;
  children: React.ReactNode;
  /** Total unread message count to badge on Sessions icon */
  totalUnread?: number;
}

const BASE_NAV_ITEMS: IconRailItem[] = [
  { id: "sessions", icon: <Play size={18} strokeWidth={1.5} />, label: "Sessions" },
  { id: "agents", icon: <Bot size={18} strokeWidth={1.5} />, label: "Agents" },
  { id: "flows", icon: <Zap size={18} strokeWidth={1.5} />, label: "Flows" },
  { id: "compute", icon: <Monitor size={18} strokeWidth={1.5} />, label: "Compute" },
  { id: "history", icon: <Clock size={18} strokeWidth={1.5} />, label: "History" },
  { id: "memory", icon: <BookOpen size={18} strokeWidth={1.5} />, label: "Knowledge" },
  { id: "tools", icon: <Wrench size={18} strokeWidth={1.5} />, label: "Tools" },
  { id: "schedules", icon: <Calendar size={18} strokeWidth={1.5} />, label: "Schedules" },
  { id: "costs", icon: <DollarSign size={18} strokeWidth={1.5} />, label: "Costs" },
];

const SETTINGS_ITEM = { id: "settings", icon: <Cog size={18} strokeWidth={1.5} />, label: "Settings" };

const SHORTCUTS: Record<string, string> = {
  s: "sessions",
  a: "agents",
  f: "flows",
  c: "compute",
  h: "history",
  m: "memory",
  t: "tools",
  $: "costs",
  ",": "settings",
};

export function Layout({ view, onNavigate, daemonStatus, children, totalUnread }: LayoutProps) {
  const navItems = useMemo(() => {
    if (!totalUnread) return BASE_NAV_ITEMS;
    return BASE_NAV_ITEMS.map((item) => (item.id === "sessions" ? { ...item, badge: totalUnread } : item));
  }, [totalUnread]);

  // Keyboard shortcuts for navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();
      const target = SHORTCUTS[key] || SHORTCUTS[e.key];
      if (target) {
        e.preventDefault();
        onNavigate(target);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onNavigate]);

  return (
    <div className="flex h-screen bg-[var(--bg)] overflow-hidden">
      <IconRail
        items={navItems}
        activeId={view}
        onSelect={onNavigate}
        settingsItem={SETTINGS_ITEM}
        daemonStatus={daemonStatus}
      />
      <div className="flex-1 flex min-w-0 overflow-hidden">{children}</div>
    </div>
  );
}

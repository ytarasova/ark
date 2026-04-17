import { useEffect } from "react";
import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip.js";
import {
  Play,
  Wrench,
  Clock,
  Calendar,
  BookOpen,
  DollarSign,
  Cog,
  ChevronLeft,
  ChevronRight,
  LayoutDashboard,
  Bot,
  Zap,
  Monitor,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DaemonStatus } from "../hooks/useDaemonStatus.js";

interface SidebarProps {
  activeView: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  collapsed: boolean;
  onToggle: () => void;
  daemonStatus?: DaemonStatus | null;
}

/** Derive overall health from daemon probe results. */
function getDotState(ds: DaemonStatus | null | undefined): { color: string; glow: string; title: string } {
  if (!ds) return { color: "bg-muted-foreground/30", glow: "", title: "Checking daemons..." };
  const { conductor, arkd } = ds;
  if (conductor.online && arkd.online) {
    return {
      color: "bg-[var(--running)]",
      glow: "shadow-[var(--running-glow)] animate-[glow-pulse_2.5s_ease-in-out_infinite]",
      title: "Conductor and arkd online",
    };
  }
  if (conductor.online || arkd.online) {
    return {
      color: "bg-[var(--waiting)]",
      glow: "",
      title: `${conductor.online ? "Conductor" : "arkd"} online, ${conductor.online ? "arkd" : "conductor"} offline`,
    };
  }
  return {
    color: "bg-[var(--failed)]",
    glow: "",
    title: "Conductor and arkd offline",
  };
}

interface NavItem {
  id: string;
  icon: LucideIcon;
  label: string;
  shortcut?: string;
}

const NAV: NavItem[] = [
  { id: "dashboard", icon: LayoutDashboard, label: "Dashboard", shortcut: "D" },
  { id: "sessions", icon: Play, label: "Sessions", shortcut: "S" },
  { id: "agents", icon: Bot, label: "Agents", shortcut: "A" },
  { id: "flows", icon: Zap, label: "Flows", shortcut: "F" },
  { id: "compute", icon: Monitor, label: "Compute", shortcut: "C" },
  { id: "history", icon: Clock, label: "History", shortcut: "H" },
  { id: "memory", icon: BookOpen, label: "Memory", shortcut: "M" },
  { id: "tools", icon: Wrench, label: "Tools", shortcut: "T" },
  { id: "schedules", icon: Calendar, label: "Schedules" },
  { id: "costs", icon: DollarSign, label: "Costs", shortcut: "$" },
];

const SETTINGS_ITEM: NavItem = { id: "settings", icon: Cog, label: "Settings", shortcut: "," };

function NavButton({
  item,
  active,
  collapsed,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const button = (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      className={cn(
        "w-full text-[13px] font-medium",
        collapsed ? "justify-center px-0" : "justify-start gap-2.5",
        "text-muted-foreground hover:text-sidebar-accent-foreground hover:bg-sidebar-accent",
        active && "text-sidebar-foreground bg-sidebar-accent border-l-2 border-l-sidebar-primary",
      )}
    >
      <item.icon size={15} className="opacity-50 shrink-0" />
      {!collapsed && <span className="sidebar-label flex-1 text-left max-md:hidden">{item.label}</span>}
      {!collapsed && item.shortcut && (
        <kbd className="sidebar-label hidden md:inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 text-[10px] font-mono text-muted-foreground">
          {item.shortcut}
        </kbd>
      )}
    </Button>
  );

  if (collapsed) {
    const tooltipText = item.shortcut ? `${item.label} (${item.shortcut})` : item.label;
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
    );
  }

  return button;
}

export function Sidebar({ activeView, onNavigate, readOnly, collapsed, onToggle, daemonStatus }: SidebarProps) {
  const dot = getDotState(daemonStatus);

  // Cmd+B (Mac) / Ctrl+B (other) toggles the sidebar
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Skip if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        onToggle();
        return;
      }

      // Navigation shortcuts -- only when no modifier keys (except shift for $)
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key;
      for (const item of NAV) {
        if (item.shortcut && item.shortcut.toLowerCase() === key.toLowerCase()) {
          e.preventDefault();
          onNavigate(item.id);
          return;
        }
      }
      if (SETTINGS_ITEM.shortcut && key === SETTINGS_ITEM.shortcut) {
        e.preventDefault();
        onNavigate(SETTINGS_ITEM.id);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onToggle, onNavigate]);

  return (
    <TooltipProvider>
      <div
        className={cn(
          "bg-sidebar border-r border-sidebar-border flex flex-col h-full overflow-y-auto overflow-x-hidden relative z-2",
          "transition-[width] duration-200 ease-in-out",
          collapsed ? "w-[48px]" : "w-[200px] max-md:w-[48px]",
        )}
      >
        {/* Header - compact, draggable */}
        <div
          className={cn(
            "h-[44px] px-3.5 flex items-center gap-2 drag-region shrink-0",
            collapsed && "justify-center px-0",
          )}
        >
          {!collapsed && (
            <>
              <span
                data-testid="sidebar-brand"
                className="sidebar-label text-[15px] font-bold text-sidebar-foreground tracking-[-0.03em]"
              >
                ark
              </span>
              <span
                className={cn("w-[7px] h-[7px] rounded-full shrink-0 no-drag sidebar-label", dot.color, dot.glow)}
                title={dot.title}
              />
              <span className="flex-1" />
            </>
          )}
          <button
            onClick={onToggle}
            className="no-drag p-1 rounded hover:bg-sidebar-accent text-muted-foreground hover:text-sidebar-foreground transition-colors shrink-0"
            title={collapsed ? "Expand sidebar (Cmd+B)" : "Collapse sidebar (Cmd+B)"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>

        {/* Navigation */}
        <nav className={cn("flex-1 px-2 py-1 no-drag space-y-0.5", collapsed && "px-1")}>
          {NAV.map((it) => (
            <NavButton
              key={it.id}
              item={it}
              active={activeView === it.id}
              collapsed={collapsed}
              onClick={() => onNavigate(it.id)}
            />
          ))}
        </nav>

        {/* Settings */}
        <div className={cn("px-2 py-1 no-drag border-t border-sidebar-border", collapsed && "px-1")}>
          <NavButton
            item={SETTINGS_ITEM}
            active={activeView === "settings"}
            collapsed={collapsed}
            onClick={() => onNavigate("settings")}
          />
        </div>

        {/* Footer */}
        <div className="h-8 flex items-center justify-center text-[10px] text-muted-foreground/40 font-mono shrink-0 no-drag">
          {collapsed ? "" : readOnly ? "read-only" : `v${__ARK_VERSION__}`}
        </div>
      </div>
    </TooltipProvider>
  );
}

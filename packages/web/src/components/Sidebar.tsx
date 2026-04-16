import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import {
  Play, Settings, Wrench, GitBranch, Clock, Server,
  Calendar, BookOpen, DollarSign, Flame, Cog,
  ChevronLeft, ChevronRight, LayoutDashboard,
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
      color: "bg-emerald-400",
      glow: "shadow-[0_0_8px_rgba(52,211,153,0.5),0_0_2px_rgba(52,211,153,0.8)] animate-[glow-pulse_2.5s_ease-in-out_infinite]",
      title: "Conductor and arkd online",
    };
  }
  if (conductor.online || arkd.online) {
    return {
      color: "bg-amber-400",
      glow: "shadow-[0_0_8px_rgba(251,191,36,0.5),0_0_2px_rgba(251,191,36,0.8)]",
      title: `${conductor.online ? "Conductor" : "arkd"} online, ${conductor.online ? "arkd" : "conductor"} offline`,
    };
  }
  return {
    color: "bg-red-400",
    glow: "",
    title: "Conductor and arkd offline",
  };
}

const NAV: { id: string; icon: LucideIcon; label: string }[] = [
  { id: "dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { id: "sessions", icon: Play, label: "Sessions" },
  { id: "agents", icon: Settings, label: "Agents" },
  { id: "flows", icon: GitBranch, label: "Flows" },
  { id: "compute", icon: Server, label: "Compute" },
  { id: "history", icon: Clock, label: "History" },
  { id: "memory", icon: BookOpen, label: "Memory" },
  { id: "tools", icon: Wrench, label: "Tools" },
  { id: "schedules", icon: Calendar, label: "Schedules" },
  { id: "costs", icon: DollarSign, label: "Costs" },
  { id: "burn", icon: Flame, label: "CodeBurn (local)" },
];

export function Sidebar({ activeView, onNavigate, readOnly, collapsed, onToggle, daemonStatus }: SidebarProps) {
  const dot = getDotState(daemonStatus);
  return (
    <div className="bg-sidebar border-r border-sidebar-border flex flex-col h-full overflow-y-auto relative z-2">
      {/* Header - compact, draggable */}
      <div className={cn("h-[44px] px-3.5 flex items-center gap-2 drag-region shrink-0", collapsed && "justify-center px-0")}>
        {!collapsed && (
          <>
            <span className="text-[15px] font-bold text-sidebar-foreground tracking-[-0.03em]">ark</span>
            <span className={cn("w-[7px] h-[7px] rounded-full shrink-0 no-drag", dot.color, dot.glow)} title={dot.title} />
            <span className="flex-1" />
          </>
        )}
        <button
          onClick={onToggle}
          className="no-drag p-1 rounded hover:bg-sidebar-accent text-muted-foreground hover:text-sidebar-foreground transition-colors shrink-0"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
        </button>
      </div>

      {/* Navigation */}
      <nav className={cn("flex-1 px-2 py-1 no-drag space-y-0.5", collapsed && "px-1")}>
        {NAV.map((it) => (
          <Button
            key={it.id}
            variant="ghost"
            size="sm"
            onClick={() => onNavigate(it.id)}
            title={collapsed ? it.label : undefined}
            className={cn(
              "w-full text-[13px] font-medium",
              collapsed ? "justify-center px-0" : "justify-start gap-2.5",
              "text-muted-foreground hover:text-sidebar-accent-foreground hover:bg-sidebar-accent",
              activeView === it.id && "text-sidebar-foreground bg-sidebar-accent border-l-2 border-l-sidebar-primary"
            )}
          >
            <it.icon size={15} className="opacity-50 shrink-0" />
            {!collapsed && <span className="max-md:hidden">{it.label}</span>}
          </Button>
        ))}
      </nav>

      {/* Settings */}
      <div className={cn("px-2 py-1 no-drag border-t border-sidebar-border", collapsed && "px-1")}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onNavigate("settings")}
          title={collapsed ? "Settings" : undefined}
          className={cn(
            "w-full text-[13px] font-medium",
            collapsed ? "justify-center px-0" : "justify-start gap-2.5",
            "text-muted-foreground hover:text-sidebar-accent-foreground hover:bg-sidebar-accent",
            activeView === "settings" && "text-sidebar-foreground bg-sidebar-accent border-l-2 border-l-sidebar-primary"
          )}
        >
          <Cog size={15} className="opacity-50 shrink-0" />
          {!collapsed && <span className="max-md:hidden">Settings</span>}
        </Button>
      </div>

      {/* Footer */}
      <div className="h-8 flex items-center justify-center text-[10px] text-muted-foreground/40 font-mono shrink-0 no-drag">
        {collapsed ? "" : readOnly ? "read-only" : `v${__ARK_VERSION__}`}
      </div>
    </div>
  );
}

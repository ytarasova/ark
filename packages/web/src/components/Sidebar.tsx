import { cn } from "../lib/utils.js";
import { Button } from "./ui/button.js";
import { Separator } from "./ui/separator.js";
import {
  Play, Settings, Wrench, GitBranch, Clock, Server,
  Calendar, BookOpen, DollarSign, Cog,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface SidebarProps {
  activeView: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
}

const NAV: { id: string; icon: LucideIcon; label: string }[] = [
  { id: "sessions", icon: Play, label: "Sessions" },
  { id: "agents", icon: Settings, label: "Agents" },
  { id: "flows", icon: GitBranch, label: "Flows" },
  { id: "compute", icon: Server, label: "Compute" },
  { id: "history", icon: Clock, label: "History" },
  { id: "memory", icon: BookOpen, label: "Memory" },
  { id: "tools", icon: Wrench, label: "Tools" },
  { id: "schedules", icon: Calendar, label: "Schedules" },
  { id: "costs", icon: DollarSign, label: "Costs" },
];

export function Sidebar({ activeView, onNavigate, readOnly }: SidebarProps) {
  return (
    <div className="bg-sidebar border-r border-sidebar-border flex flex-col h-full overflow-y-auto relative z-2">
      {/* Header - compact, draggable */}
      <div className="h-[44px] px-3.5 flex items-center gap-2 drag-region shrink-0">
        <span className="text-[15px] font-bold text-sidebar-foreground tracking-[-0.03em]">ark</span>
        <span className="w-[7px] h-[7px] rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5),0_0_2px_rgba(52,211,153,0.8)] animate-[glow-pulse_2.5s_ease-in-out_infinite] shrink-0 no-drag" />
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-1 no-drag space-y-0.5">
        {NAV.map((it) => (
          <Button
            key={it.id}
            variant="ghost"
            size="sm"
            onClick={() => onNavigate(it.id)}
            className={cn(
              "w-full justify-start gap-2.5 text-[13px] font-medium",
              "text-muted-foreground hover:text-sidebar-accent-foreground hover:bg-sidebar-accent",
              activeView === it.id && "text-sidebar-foreground bg-sidebar-accent border-l-2 border-l-sidebar-primary"
            )}
          >
            <it.icon size={15} className="opacity-50 shrink-0" />
            <span className="max-md:hidden">{it.label}</span>
          </Button>
        ))}
      </nav>

      {/* Settings */}
      <div className="px-2 py-1 no-drag border-t border-sidebar-border">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onNavigate("settings")}
          className={cn(
            "w-full justify-start gap-2.5 text-[13px] font-medium",
            "text-muted-foreground hover:text-sidebar-accent-foreground hover:bg-sidebar-accent",
            activeView === "settings" && "text-sidebar-foreground bg-sidebar-accent border-l-2 border-l-sidebar-primary"
          )}
        >
          <Cog size={15} className="opacity-50 shrink-0" />
          <span className="max-md:hidden">Settings</span>
        </Button>
      </div>

      {/* Footer */}
      <div className="h-8 flex items-center justify-center text-[10px] text-muted-foreground/40 font-mono shrink-0 no-drag">
        {readOnly ? "read-only" : "v0.10.0"}
      </div>
    </div>
  );
}

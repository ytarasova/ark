import { cn } from "../lib/utils.js";
import {
  Play, Settings, Wrench, GitBranch, Clock, Server,
  Calendar, BookOpen, DollarSign, LayoutGrid,
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
  { id: "tools", icon: Wrench, label: "Tools" },
  { id: "flows", icon: GitBranch, label: "Flows" },
  { id: "history", icon: Clock, label: "History" },
  { id: "compute", icon: Server, label: "Compute" },
  { id: "schedules", icon: Calendar, label: "Schedules" },
  { id: "memory", icon: BookOpen, label: "Memory" },
  { id: "costs", icon: DollarSign, label: "Costs" },
  { id: "status", icon: LayoutGrid, label: "System" },
];

export function Sidebar({ activeView, onNavigate, readOnly }: SidebarProps) {
  return (
    <div className="bg-[#0a0a0e] border-r border-white/[0.06] flex flex-col h-full overflow-y-auto relative z-2">
      {/* Header - compact, draggable */}
      <div className="h-[44px] px-3.5 flex items-center gap-2 drag-region shrink-0">
        <span className="text-[15px] font-bold text-white/90 tracking-[-0.03em]">ark</span>
        <span className="w-[7px] h-[7px] rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5),0_0_2px_rgba(52,211,153,0.8)] animate-[glow-pulse_2.5s_ease-in-out_infinite] shrink-0 no-drag" />
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-1 no-drag space-y-0.5">
        {NAV.map((it) => (
          <button
            key={it.id}
            onClick={() => onNavigate(it.id)}
            className={cn(
              "w-full flex items-center gap-2.5 px-3 h-8 text-[13px] font-medium rounded-md transition-colors",
              "text-white/50 hover:text-white/80 hover:bg-white/[0.04]",
              activeView === it.id && "text-white/90 bg-white/[0.06] border-l-2 border-l-indigo-400"
            )}
          >
            <it.icon size={15} className="opacity-50 shrink-0" />
            <span className="max-md:hidden">{it.label}</span>
          </button>
        ))}
      </nav>

      {/* Footer */}
      <div className="h-10 flex items-center justify-center border-t border-white/[0.06] text-[11px] text-white/25 font-mono shrink-0 no-drag">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.4)] mr-1.5" />
        {readOnly ? "read-only" : "connected"}
      </div>
    </div>
  );
}

import { cn } from "../lib/utils.js";

interface SidebarProps {
  activeView: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
}

// SVG icon components (Lucide-style, 16x16 stroke icons)
// These are static constants, not user input -- safe for innerHTML
function Icon({ svg }: { svg: string }) {
  // eslint-disable-next-line react/no-danger
  return <span className="w-[18px] h-[18px] flex items-center justify-center shrink-0 opacity-55" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const SVG: Record<string, string> = {
  sessions: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>',
  agents: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  tools: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>',
  flows: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  history: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  compute: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1"/><circle cx="6" cy="18" r="1"/></svg>',
  schedules: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  memory: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
  costs: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  status: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
};

const NAV_ITEMS = [
  { id: "sessions", label: "Sessions" },
  { id: "agents", label: "Agents" },
  { id: "tools", label: "Tools" },
  { id: "flows", label: "Flows" },
  { id: "history", label: "History" },
  { id: "compute", label: "Compute" },
  { id: "schedules", label: "Schedules" },
  { id: "memory", label: "Memory" },
  { id: "costs", label: "Costs" },
  { id: "status", label: "System" },
];

export function Sidebar({ activeView, onNavigate, readOnly }: SidebarProps) {
  return (
    <div className="glass-surface-xl bg-glass-dark border-r border-white/8 flex flex-col h-full overflow-y-auto relative z-2">
      <div className="h-[52px] px-4 pt-2 flex items-center gap-2 drag-region shrink-0">
        <span className="text-base font-bold text-label tracking-[-0.03em]">ark</span>
        <span className="w-[7px] h-[7px] rounded-full bg-success shadow-[0_0_8px_rgba(50,213,131,0.5),0_0_2px_rgba(50,213,131,0.8)] animate-[glow-pulse_2.5s_ease-in-out_infinite] shrink-0 no-drag" />
      </div>
      <nav className="flex-1 py-2 no-drag">
        {NAV_ITEMS.map((it) => (
          <div
            key={it.id}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 mx-2 rounded-lg text-sm font-medium cursor-pointer select-none transition-all duration-200 no-drag",
              activeView === it.id
                ? "bg-white/12 text-white/92 glass-shine-subtle [&_.icon-wrap]:opacity-85"
                : "text-white/55 hover:text-white/80 hover:bg-white/8 [&_.icon-wrap]:opacity-55"
            )}
            onClick={() => onNavigate(it.id)}
          >
            <span className={cn("icon-wrap w-[18px] h-[18px] flex items-center justify-center shrink-0", activeView === it.id ? "opacity-85" : "opacity-55")} dangerouslySetInnerHTML={{ __html: SVG[it.id] || "" }} />
            <span className="max-md:hidden tracking-[-0.01em]">{it.label}</span>
          </div>
        ))}
      </nav>
      <div className="h-10 flex items-center justify-center border-t border-white/8 text-[11px] text-label-quaternary font-mono shrink-0 no-drag">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-success shadow-[0_0_8px_rgba(50,213,131,0.5),0_0_2px_rgba(50,213,131,0.8)] mr-1.5" />
        {readOnly ? "read-only" : "connected"}
      </div>
    </div>
  );
}

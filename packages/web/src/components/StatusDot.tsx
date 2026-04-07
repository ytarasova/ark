import { cn } from "../lib/utils.js";

const DOT: Record<string, string> = {
  running: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)] animate-[glow-pulse_2.5s_ease-in-out_infinite]",
  waiting: "bg-amber-400",
  completed: "bg-blue-400",
  failed: "bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.4)]",
  stopped: "bg-white/20",
  pending: "bg-white/20",
  ready: "bg-white/20",
  archived: "bg-white/15",
  deleting: "bg-white/10 animate-pulse",
};

const BADGE: Record<string, string> = {
  running: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  waiting: "bg-amber-500/15 text-amber-400 border-amber-500/20",
  completed: "bg-blue-500/15 text-blue-400 border-blue-500/20",
  failed: "bg-red-500/15 text-red-400 border-red-500/20",
  stopped: "bg-white/5 text-white/30 border-white/[0.06]",
  pending: "bg-white/5 text-white/30 border-white/[0.06]",
  ready: "bg-white/5 text-white/30 border-white/[0.06]",
  archived: "bg-white/5 text-white/25 border-white/[0.06]",
  deleting: "bg-white/5 text-white/20 border-white/[0.06]",
};

export function StatusDot({ status }: { status?: string }) {
  return (
    <span className={cn(
      "inline-block w-2 h-2 rounded-full shrink-0",
      DOT[status || "pending"] || "bg-white/20"
    )} />
  );
}

export function StatusBadge({ status }: { status?: string }) {
  return (
    <span className={cn(
      "inline-block px-2 py-0.5 rounded text-[10px] font-mono font-medium uppercase tracking-wider border",
      BADGE[status || "pending"] || "bg-white/5 text-white/30 border-white/[0.06]"
    )}>
      {status || "unknown"}
    </span>
  );
}

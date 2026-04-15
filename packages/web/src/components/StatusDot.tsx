import { cn } from "../lib/utils.js";

const DOT: Record<string, string> = {
  running: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)] animate-[glow-pulse_2.5s_ease-in-out_infinite]",
  waiting: "bg-amber-400",
  completed: "bg-blue-400",
  failed: "bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.4)]",
  stopped: "bg-muted-foreground/30",
  pending: "bg-muted-foreground/30",
  ready: "bg-muted-foreground/30",
  archived: "bg-muted-foreground/20",
  deleting: "bg-muted-foreground/15 animate-pulse",
};

const BADGE: Record<string, string> = {
  running: "bg-emerald-500/15 text-emerald-400 border-emerald-500/20",
  waiting: "bg-amber-500/15 text-amber-400 border-amber-500/20",
  completed: "bg-blue-500/15 text-blue-400 border-blue-500/20",
  failed: "bg-red-500/15 text-red-400 border-red-500/20",
  stopped: "bg-secondary text-muted-foreground border-border",
  pending: "bg-secondary text-muted-foreground border-border",
  ready: "bg-secondary text-muted-foreground border-border",
  archived: "bg-secondary text-muted-foreground border-border",
  deleting: "bg-secondary text-muted-foreground border-border",
};

export function StatusDot({ status }: { status?: string }) {
  return (
    <span
      className={cn("inline-block w-2 h-2 rounded-full shrink-0", DOT[status || "pending"] || "bg-muted-foreground/30")}
    />
  );
}

export function StatusBadge({ status }: { status?: string }) {
  return (
    <span
      className={cn(
        "inline-block px-2 py-0.5 rounded text-[10px] font-mono font-medium uppercase tracking-wider border",
        BADGE[status || "pending"] || "bg-secondary text-muted-foreground border-border",
      )}
    >
      {status || "unknown"}
    </span>
  );
}

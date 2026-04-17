import { cn } from "../lib/utils.js";

const DOT: Record<string, string> = {
  running: "bg-[var(--running)] shadow-[0_0_6px_rgba(96,165,250,0.5)] animate-pulse",
  waiting: "bg-[var(--waiting)]",
  completed: "bg-[var(--completed)] shadow-[0_0_4px_rgba(52,211,153,0.4)]",
  failed: "bg-[var(--failed)] shadow-[0_0_4px_rgba(248,113,113,0.4)]",
  stopped: "bg-muted-foreground/30",
  pending: "bg-muted-foreground/30",
  ready: "bg-muted-foreground/30",
  archived: "bg-muted-foreground/20",
  deleting: "bg-muted-foreground/15 animate-pulse",
};

const BADGE: Record<string, string> = {
  running: "bg-[var(--running)]/15 text-[var(--running)] border-[var(--running)]/20",
  waiting: "bg-[var(--waiting)]/15 text-[var(--waiting)] border-[var(--waiting)]/20",
  completed: "bg-[var(--completed)]/15 text-[var(--completed)] border-[var(--completed)]/20",
  failed: "bg-[var(--failed)]/15 text-[var(--failed)] border-[var(--failed)]/20",
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

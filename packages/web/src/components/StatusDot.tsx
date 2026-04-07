import { cn } from "../lib/utils.js";

const STATUS_DOT_CLASSES: Record<string, string> = {
  running: "bg-success shadow-[0_0_8px_rgba(50,213,131,0.5)] animate-[glow-pulse_2.5s_ease-in-out_infinite]",
  waiting: "bg-warning shadow-[0_0_4px_rgba(245,197,66,0.3)]",
  completed: "bg-info",
  failed: "bg-danger shadow-[0_0_6px_rgba(244,85,85,0.3)]",
  stopped: "bg-white/16",
  pending: "bg-white/16",
  ready: "bg-white/16",
  archived: "bg-white/10",
  deleting: "bg-white/16 opacity-40 animate-[delete-fade_1.2s_ease-in-out_infinite]",
};

const STATUS_BADGE_CLASSES: Record<string, string> = {
  running: "bg-success-dim text-success",
  waiting: "bg-warning-dim text-warning",
  completed: "bg-info-dim text-info",
  failed: "bg-danger-dim text-danger",
  stopped: "bg-white/6 text-white/30",
  pending: "bg-white/6 text-white/30",
  ready: "bg-white/6 text-white/30",
  deleting: "bg-white/4 text-white/16",
  archived: "bg-white/4 text-white/16",
};

export function StatusDot({ status }: { status?: string }) {
  return (
    <span className={cn(
      "inline-block w-2 h-2 rounded-full shrink-0",
      STATUS_DOT_CLASSES[status || "pending"] || "bg-white/16"
    )} />
  );
}

export function StatusBadge({ status }: { status?: string }) {
  return (
    <span className={cn(
      "inline-flex items-center px-2.5 py-[3px] rounded-full text-[10px] font-semibold uppercase tracking-[0.04em] font-mono backdrop-blur-[10px] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
      STATUS_BADGE_CLASSES[status || "pending"] || "bg-white/6 text-white/30"
    )}>
      {status || "unknown"}
    </span>
  );
}

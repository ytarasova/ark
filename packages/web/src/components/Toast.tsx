import { useEffect } from "react";
import { cn } from "../lib/utils.js";

export function Toast({ message, type, onDone }: { message: string; type: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3000);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div
      className={cn(
        "fixed bottom-5 right-5 px-[18px] py-2.5 bg-card border border-border rounded-xl text-foreground text-[13px] font-medium z-[300] shadow-[0_4px_20px_rgba(0,0,0,0.4)] animate-[slide-up_300ms_cubic-bezier(0.32,0.72,0,1)] flex items-center gap-2",
        type === "success" && "border-l-[3px] border-l-[var(--running)]",
        type === "error" && "border-l-[3px] border-l-[var(--failed)]",
      )}
    >
      {type === "success" && <span className="text-[var(--running)] font-bold">{"\u2713"}</span>}
      {type === "error" && <span className="text-[var(--failed)] font-bold">{"\u2717"}</span>}
      {message}
    </div>
  );
}

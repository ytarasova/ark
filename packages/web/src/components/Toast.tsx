import { useEffect, useState } from "react";
import { cn } from "../lib/utils.js";

export function Toast({ message, type, onDone }: { message: string; type: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const dismissMs = type === "error" ? 8000 : 3000;

  useEffect(() => {
    const t = setTimeout(onDone, dismissMs);
    return () => clearTimeout(t);
  }, [onDone, dismissMs]);

  const isLong = message.length > 80;

  function handleCopy() {
    navigator.clipboard.writeText(message).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  // SR announcement: errors are assertive (role=alert), others polite (role=status).
  // See `.workflow/audit/8-a11y.md` finding B2.
  const isError = type === "error";
  const role = isError ? "alert" : "status";
  const ariaLive = isError ? "assertive" : "polite";

  return (
    <div
      role={role}
      aria-live={ariaLive}
      aria-atomic="true"
      className={cn(
        "fixed bottom-5 right-5 px-[18px] py-2.5 bg-card border border-border rounded-xl text-foreground text-[13px] font-medium z-[300] shadow-[0_4px_20px_rgba(0,0,0,0.4)] animate-[slide-up_300ms_cubic-bezier(0.32,0.72,0,1)] flex items-start gap-2",
        type === "success" && "border-l-[3px] border-l-[var(--running)]",
        type === "error" && "border-l-[3px] border-l-[var(--failed)]",
        isLong ? "max-w-[420px]" : "max-w-[340px]",
      )}
    >
      <span className="shrink-0 mt-px">
        {type === "success" && <span className="text-[var(--running)] font-bold">{"\u2713"}</span>}
        {type === "error" && <span className="text-[var(--failed)] font-bold">{"\u2717"}</span>}
      </span>
      <span className="whitespace-pre-wrap break-words leading-snug flex-1">{message}</span>
      {type === "error" && isLong && (
        <button
          onClick={handleCopy}
          className="shrink-0 text-[10px] text-[var(--fg-muted)] hover:text-foreground transition-colors mt-px cursor-pointer"
          aria-label="Copy error message"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}

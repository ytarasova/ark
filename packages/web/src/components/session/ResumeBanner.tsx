import { cn } from "../../lib/utils.js";
import { RotateCcw, X } from "lucide-react";

export interface ResumeBannerProps {
  /** Human checkpoint label (iteration #, stage name, …). */
  checkpoint: string;
  /** Called when the user confirms resume. */
  onResume?: () => void;
  onDismiss?: () => void;
  className?: string;
}

/**
 * Resume-from-checkpoint banner (Phase 3).
 *
 * Dense 2-row row with a warm primary-tinted surface, inline Resume primary
 * button, and optional dismiss. Styled after the sub-hd / panel language in
 * app-chrome.html -- not a full modal, just a thin callout above the body.
 */
export function ResumeBanner({ checkpoint, onResume, onDismiss, className }: ResumeBannerProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-[10px] px-[18px] py-[8px]",
        "border-b border-[rgba(107,89,222,0.25)]",
        "bg-[linear-gradient(180deg,rgba(107,89,222,0.08),rgba(107,89,222,0.02))]",
        className,
      )}
      role="status"
    >
      <RotateCcw size={13} className="text-[var(--primary)] shrink-0" />
      <div className="flex-1 min-w-0 flex flex-col gap-[1px]">
        <div className="font-[family-name:var(--font-sans)] text-[12px] font-medium text-[var(--fg)]">
          Resume from checkpoint
        </div>
        <div className="font-[family-name:var(--font-mono-ui)] text-[10px] text-[var(--fg-muted)] uppercase tracking-[0.04em]">
          {checkpoint}
        </div>
      </div>
      {onResume && (
        <button
          type="button"
          onClick={onResume}
          className={cn(
            "inline-flex items-center gap-[5px] h-[24px] px-[10px] rounded-[5px] cursor-pointer",
            "bg-[var(--primary)] text-white font-[family-name:var(--font-sans)] text-[11px] font-semibold",
            "border border-[rgba(0,0,0,0.25)] shadow-[0_1px_2px_rgba(0,0,0,0.25)]",
            "hover:bg-[#7d6be8] active:bg-[#5f4ed0] transition-colors",
          )}
        >
          Resume
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="inline-flex items-center justify-center w-[22px] h-[22px] rounded bg-transparent border-0 text-[var(--fg-muted)] hover:text-[var(--fg)] hover:bg-[var(--bg-hover)] cursor-pointer"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

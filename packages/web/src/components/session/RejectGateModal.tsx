import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils.js";

export interface RejectGateModalProps {
  reason: string;
  submitting: boolean;
  onReasonChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

/**
 * Modal prompting the reviewer for a rejection reason before re-dispatching
 * the session. The dialog traps focus itself; Escape cancels, Enter submits
 * once a reason is provided.
 */
export function RejectGateModal({ reason, submitting, onReasonChange, onCancel, onSubmit }: RejectGateModalProps) {
  const canSubmit = reason.trim().length > 0 && !submitting;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reject-gate-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--bg-overlay)]"
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className="w-[480px] max-w-[90vw] rounded-[var(--radius-lg)] bg-[var(--bg-popover)] border border-[var(--border)] shadow-[0_4px_16px_rgba(0,0,0,0.3)] p-5">
        <h2 id="reject-gate-title" className="text-[14px] font-semibold text-[var(--fg)] mb-2">
          Reject and request rework
        </h2>
        <p className="text-[12px] text-[var(--fg-muted)] mb-3">
          Describe the issue. The reason is shown to the agent on the next dispatch.
        </p>
        <label className="block mb-3">
          <span className="sr-only">Rejection reason</span>
          <textarea
            aria-label="Rejection reason"
            className={cn(
              "w-full min-h-[110px] text-[12px] p-2 rounded-[var(--radius-sm)]",
              "border border-[var(--border)] bg-[var(--bg-hover)] text-[var(--fg)]",
              "focus:outline-none focus:ring-2 focus:ring-[var(--running)]",
            )}
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="Tests missing for the new service; please add coverage and rerun."
            autoFocus
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className={cn(
              "h-7 px-3 rounded-[var(--radius-sm)] text-[11px] font-medium",
              "border border-[var(--border)] bg-transparent text-[var(--fg)]",
              "hover:bg-[var(--bg-hover)] transition-colors cursor-pointer",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className={cn(
              "h-7 px-3 rounded-[var(--radius-sm)] text-[11px] font-medium",
              "border border-[var(--failed)] bg-[var(--failed)] text-white",
              "hover:opacity-90 transition-opacity cursor-pointer",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "flex items-center gap-1",
            )}
          >
            {submitting ? (
              <>
                <Loader2 className="animate-spin" size={12} /> Submitting...
              </>
            ) : (
              "Submit"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

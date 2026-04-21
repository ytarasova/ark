import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils.js";

export type SessionAction = "stop" | "restart" | "archive" | "delete" | "approve" | "reject";

interface HeaderActionsProps {
  status: string | undefined;
  isActive: boolean;
  canShowGate: boolean;
  actionLoading: string | null;
  onAction: (action: "stop" | "archive") => void;
  onDelete: () => void;
  onApprove: () => void;
  onOpenReject: () => void;
  /** Opens the Restart-from-stage dialog; caller drives the actual restart. */
  onOpenRestart: () => void;
}

/**
 * Action buttons rendered in the `SessionHeader` slot: Approve/Reject on
 * review gates, Stop while active, Restart once restartable, plus Archive
 * and Delete. The set shown depends on status + review-gate state, so this
 * component owns the visibility logic.
 */
export function HeaderActions({
  status,
  isActive,
  canShowGate,
  actionLoading,
  onAction,
  onDelete,
  onApprove,
  onOpenReject,
  onOpenRestart,
}: HeaderActionsProps) {
  const showRestart =
    status === "ready" ||
    status === "pending" ||
    status === "blocked" ||
    status === "stopped" ||
    status === "failed" ||
    status === "completed";

  return (
    <div className="flex gap-1.5 shrink-0">
      {canShowGate && (
        <>
          <button
            type="button"
            onClick={onApprove}
            disabled={actionLoading === "approve"}
            aria-label="Approve review gate"
            className={cn(
              "h-7 px-2.5 rounded-[var(--radius-sm)] text-[11px] font-medium",
              "border border-[var(--running)] bg-transparent text-[var(--running)]",
              "hover:bg-[var(--diff-add-bg)] transition-colors cursor-pointer",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "flex items-center gap-1",
            )}
          >
            {actionLoading === "approve" ? (
              <>
                <Loader2 className="animate-spin" size={12} /> Approving...
              </>
            ) : (
              "Approve"
            )}
          </button>
          <button
            type="button"
            onClick={onOpenReject}
            disabled={actionLoading === "reject"}
            aria-label="Reject review gate"
            className={cn(
              "h-7 px-2.5 rounded-[var(--radius-sm)] text-[11px] font-medium",
              "border border-[var(--failed)] bg-transparent text-[var(--failed)]",
              "hover:bg-[var(--diff-rm-bg)] transition-colors cursor-pointer",
              "disabled:opacity-50 disabled:cursor-not-allowed",
              "flex items-center gap-1",
            )}
          >
            {actionLoading === "reject" ? (
              <>
                <Loader2 className="animate-spin" size={12} /> Rejecting...
              </>
            ) : (
              "Reject"
            )}
          </button>
        </>
      )}
      {isActive && (
        <button
          type="button"
          onClick={() => onAction("stop")}
          disabled={actionLoading === "stop"}
          aria-label="Stop session"
          className={cn(
            "h-7 px-2.5 rounded-[var(--radius-sm)] text-[11px] font-medium",
            "border border-[var(--failed)] bg-transparent text-[var(--failed)]",
            "hover:bg-[var(--diff-rm-bg)] transition-colors cursor-pointer",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "flex items-center gap-1",
          )}
        >
          {actionLoading === "stop" ? (
            <>
              <Loader2 className="animate-spin" size={12} /> Stopping...
            </>
          ) : (
            "Stop"
          )}
        </button>
      )}
      {showRestart && (
        <button
          type="button"
          onClick={onOpenRestart}
          disabled={actionLoading === "restart"}
          aria-label="Restart session"
          className={cn(
            "h-7 px-2.5 rounded-[var(--radius-sm)] text-[11px] font-medium",
            "border border-[var(--running)] bg-transparent text-[var(--running)]",
            "hover:bg-[var(--diff-add-bg)] transition-colors cursor-pointer",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "flex items-center gap-1",
          )}
        >
          {actionLoading === "restart" ? (
            <>
              <Loader2 className="animate-spin" size={12} /> Restarting...
            </>
          ) : (
            "Restart"
          )}
        </button>
      )}
      <button
        type="button"
        onClick={() => onAction("archive")}
        disabled={actionLoading === "archive"}
        aria-label="Archive session"
        className={cn(
          "h-7 px-2.5 rounded-[var(--radius-sm)] text-[11px] font-medium",
          "border border-[var(--border)] bg-transparent text-[var(--fg-muted)]",
          "hover:text-[var(--fg)] hover:border-[var(--fg-muted)] transition-colors cursor-pointer",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "flex items-center gap-1",
        )}
      >
        {actionLoading === "archive" ? (
          <>
            <Loader2 className="animate-spin" size={12} /> Archiving...
          </>
        ) : (
          "Archive"
        )}
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={actionLoading === "delete"}
        aria-label="Delete session"
        className={cn(
          "h-7 px-2.5 rounded-[var(--radius-sm)] text-[11px] font-medium",
          "border border-[var(--failed)] bg-transparent text-[var(--failed)]",
          "hover:bg-[var(--diff-rm-bg)] transition-colors cursor-pointer",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "flex items-center gap-1",
        )}
      >
        {actionLoading === "delete" ? (
          <>
            <Loader2 className="animate-spin" size={12} /> Deleting...
          </>
        ) : (
          "Delete"
        )}
      </button>
    </div>
  );
}

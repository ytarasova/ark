import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { MenuButton, type MenuItem } from "../ui/MenuButton.js";

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
 * Action buttons rendered in the `SessionHeader` slot.
 *
 * Restructured from the prior 5-buttons-always model to a state-driven
 * primary + overflow menu pattern:
 *
 *   pending|ready|running|waiting  primary: Stop          menu: Delete
 *   blocked                        primary: Approve|Reject menu: Stop, Delete
 *   stopped|completed|failed       primary: Restart       menu: Archive, Delete
 *   archived                       (none)                  menu: Restore, Delete
 *   deleting                       spinner only            (no menu)
 *
 * Approve / Reject is the only state that exposes two primary buttons
 * side-by-side (the explicit dual-choice review gate). Every other state
 * has at most one primary action; everything else is collapsed into the
 * `...` overflow menu so the header doesn't render unreachable buttons.
 *
 * Restore (for archived sessions) currently routes through the same
 * Restart-from-stage dialog as a stopped/failed restart -- archived
 * sessions are recoverable by re-dispatching, and the dialog already
 * handles the "pick a stage" affordance.
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
  if (status === "deleting") {
    return (
      <div data-testid="header-actions" className="flex items-center gap-1.5 shrink-0">
        <span
          data-testid="header-actions-deleting"
          aria-label="Deleting session"
          className="inline-flex items-center gap-1.5 text-[11px] text-[var(--fg-muted)]"
        >
          <Loader2 className="animate-spin" size={12} /> Deleting...
        </span>
      </div>
    );
  }

  const isBlocked = status === "blocked" && canShowGate;
  const isTerminal = status === "stopped" || status === "completed" || status === "failed" || status === "killed";
  const isArchived = status === "archived";

  // Build the overflow menu first so primary-button rendering can ignore it.
  const overflow: MenuItem[] = [];
  if (isBlocked) {
    overflow.push({
      id: "stop",
      label: "Stop",
      onSelect: () => onAction("stop"),
      disabled: actionLoading === "stop",
    });
    overflow.push({
      id: "delete",
      label: "Delete",
      destructive: true,
      onSelect: onDelete,
      disabled: actionLoading === "delete",
    });
  } else if (isActive) {
    // pending / ready / running / waiting
    overflow.push({
      id: "delete",
      label: "Delete",
      destructive: true,
      onSelect: onDelete,
      disabled: actionLoading === "delete",
    });
  } else if (isTerminal) {
    overflow.push({
      id: "archive",
      label: "Archive",
      onSelect: () => onAction("archive"),
      disabled: actionLoading === "archive",
    });
    overflow.push({
      id: "delete",
      label: "Delete",
      destructive: true,
      onSelect: onDelete,
      disabled: actionLoading === "delete",
    });
  } else if (isArchived) {
    overflow.push({
      id: "restore",
      label: "Restore",
      onSelect: onOpenRestart,
      disabled: actionLoading === "restart",
    });
    overflow.push({
      id: "delete",
      label: "Delete",
      destructive: true,
      onSelect: onDelete,
      disabled: actionLoading === "delete",
    });
  }

  return (
    <div data-testid="header-actions" className="flex items-center gap-1.5 shrink-0">
      {isBlocked && (
        <>
          <button
            type="button"
            onClick={onApprove}
            disabled={actionLoading === "approve"}
            aria-label="Approve review gate"
            data-testid="header-actions-approve"
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
            data-testid="header-actions-reject"
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

      {!isBlocked && isActive && (
        <button
          type="button"
          onClick={() => onAction("stop")}
          disabled={actionLoading === "stop"}
          aria-label="Stop session"
          data-testid="header-actions-stop"
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

      {!isBlocked && isTerminal && (
        <button
          type="button"
          onClick={onOpenRestart}
          disabled={actionLoading === "restart"}
          aria-label="Restart session"
          data-testid="header-actions-restart"
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

      <MenuButton items={overflow} label="More session actions" />
    </div>
  );
}

import { Modal } from "./modal.js";
import { Button } from "./button.js";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/utils.js";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as a destructive action (red). */
  danger?: boolean;
  /** Disable buttons + show a spinner on the confirm button. */
  loading?: boolean;
}

/**
 * Reusable Yes/No confirm dialog. Built on the existing `Modal`
 * (Radix-based) so focus-trap, Esc-to-close, and a11y labelling come
 * along for free. Use for destructive actions (delete, reject, etc.)
 * that previously relied on `window.confirm`.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  loading = false,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={() => !loading && onClose()} title={title}>
      <div className="flex flex-col gap-4 p-5">
        {message && <div className="text-[13px] text-[var(--fg-muted)] leading-relaxed">{message}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" size="sm" variant="outline" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => onConfirm()}
            disabled={loading}
            className={cn(
              "gap-1.5",
              danger &&
                "bg-[var(--failed)] text-white hover:bg-[var(--failed)]/85 border-[var(--failed)] hover:border-[var(--failed)]",
            )}
          >
            {loading && <Loader2 className="animate-spin" size={12} />}
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

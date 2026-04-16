import { useEffect, type ReactNode, type MouseEvent } from "react";
import { cn } from "../../lib/utils.js";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Minimal overlay modal used by the folder picker. Intentionally tiny --
 * backdrop, centered panel, Escape/backdrop-click to close. Reach for
 * something heavier only if a second consumer needs it.
 */
export function Modal({ open, onClose, title, className, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={cn(
          "flex max-h-[85vh] w-[min(560px,90vw)] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl",
          className,
        )}
        onClick={stop}
      >
        {title && <div className="border-b border-border px-5 py-3 text-sm font-semibold text-foreground">{title}</div>}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}

import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "../../lib/utils.js";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Minimal overlay modal used by the folder picker. Built on Radix
 * `Dialog` for focus trap, focus restoration, Esc-to-close,
 * `aria-modal`, and `aria-labelledby` wiring.
 *
 * See `.workflow/audit/8-a11y.md` findings A4 + B5.
 */
export function Modal({ open, onClose, title, className, children }: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          className={cn(
            "fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "flex max-h-[85vh] w-[min(560px,90vw)] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl",
            "focus:outline-none",
            className,
          )}
          aria-describedby={undefined}
        >
          {title ? (
            <Dialog.Title className="border-b border-border px-5 py-3 text-sm font-semibold text-foreground">
              {title}
            </Dialog.Title>
          ) : (
            <Dialog.Title className="sr-only">Dialog</Dialog.Title>
          )}
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

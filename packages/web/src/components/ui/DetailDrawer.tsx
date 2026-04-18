import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils.js";

interface DetailDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

/**
 * Right-side drawer built on Radix `Dialog` for focus trap, focus
 * restore, Esc to close, `role="dialog"`, `aria-modal`, and
 * `aria-labelledby` wiring via `Dialog.Title`. The original
 * slide-in transform is preserved via `data-[state]` selectors.
 *
 * See `.workflow/audit/8-a11y.md` findings A4 + B6.
 */
export function DetailDrawer({ open, onClose, title, children }: DetailDrawerProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-40 bg-black/40 transition-opacity duration-200",
            "data-[state=open]:opacity-100 data-[state=closed]:opacity-0",
          )}
        />
        <Dialog.Content
          className={cn(
            "fixed top-0 right-0 z-50 h-full w-[520px] max-w-[90vw] bg-[var(--bg)] border-l border-[var(--border)] shadow-xl",
            "transition-transform duration-200 ease-out",
            "data-[state=open]:translate-x-0 data-[state=closed]:translate-x-full",
            "focus:outline-none",
          )}
          aria-describedby={undefined}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
            <Dialog.Title className="text-[13px] font-semibold text-[var(--fg)]">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="text-[var(--fg-muted)] hover:text-[var(--fg)] transition-colors cursor-pointer bg-transparent border-none p-1 rounded-md hover:bg-[var(--bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
                aria-label="Close drawer"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {/* Content */}
          <div className="p-4 overflow-y-auto h-[calc(100%-49px)]">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

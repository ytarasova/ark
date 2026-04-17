import { useEffect } from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/utils.js";

interface DetailDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export function DetailDrawer({ open, onClose, title, children }: DetailDrawerProps) {
  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      {/* Overlay */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/40 transition-opacity duration-200",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
        onClick={onClose}
      />

      {/* Drawer panel */}
      <div
        className={cn(
          "fixed top-0 right-0 z-50 h-full w-[520px] max-w-[90vw] bg-[var(--bg)] border-l border-[var(--border)] shadow-xl",
          "transform transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <span className="text-[13px] font-semibold text-[var(--fg)]">{title}</span>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--fg-muted)] hover:text-[var(--fg)] transition-colors cursor-pointer bg-transparent border-none p-1 rounded-md hover:bg-[var(--bg-hover)]"
            aria-label="Close drawer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto h-[calc(100%-49px)]">{children}</div>
      </div>
    </>
  );
}

/**
 * Shared presentational row for a single file input. Each mode's variant
 * (local / hosted) chooses whether the "empty" slot shows a typed-path input
 * (local) or a plain "click Upload" cue (hosted), and whether the "filled"
 * slot shows the full locator or just the basename.
 *
 * The shell owns: label, required marker, preview thumbnail, upload button,
 * remove button. Content variants plug in via the `emptySlot` + `filledSlot`
 * render props.
 */

import { cn } from "../../lib/utils.js";
import { Upload, X } from "lucide-react";
import type { ReactNode } from "react";

const fieldClass = cn(
  "flex h-9 w-full rounded-md border border-[var(--border)] bg-transparent",
  "px-3 py-1 text-[13px] text-[var(--fg)] transition-colors",
  "placeholder:text-[var(--fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]",
);

export { fieldClass };

export interface FileInputRowShellProps {
  role: string;
  required: boolean;
  accept?: string;
  previewUrl?: string;
  isExtra: boolean;
  hasFile: boolean;
  /** Slot for the empty-state body (typed-path input vs "click upload" cue). */
  emptySlot: ReactNode;
  /** Slot for the filled-state body (full locator vs basename). */
  filledSlot: ReactNode;
  onUpload: (file: File) => Promise<void> | void;
  onRemove: () => void;
}

export function FileInputRowShell({
  role,
  required,
  accept,
  previewUrl,
  isExtra,
  hasFile,
  emptySlot,
  filledSlot,
  onUpload,
  onRemove,
}: FileInputRowShellProps) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-28 flex items-center gap-1.5 text-[12px] text-[var(--fg)] truncate" title={role}>
        {previewUrl && (
          <img
            src={previewUrl}
            alt=""
            className="h-6 w-6 rounded object-cover shrink-0 border border-[var(--border)]"
          />
        )}
        <span className="truncate">
          {role}
          {required ? <span className="text-[var(--failed)] ml-0.5">*</span> : null}
        </span>
      </div>
      {hasFile ? filledSlot : emptySlot}
      {!hasFile && (
        <label
          className={cn(
            "shrink-0 inline-flex items-center justify-center h-9 px-3 rounded-md cursor-pointer",
            "border border-[var(--border)] text-[12px] hover:border-[var(--fg-muted)] transition-colors",
          )}
          title="Upload file"
        >
          <Upload size={12} />
          <input
            type="file"
            className="hidden"
            accept={accept}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onUpload(f);
            }}
          />
        </label>
      )}
      {isExtra ? (
        <button
          type="button"
          aria-label={`Remove ${role}`}
          onClick={onRemove}
          className="shrink-0 h-9 w-9 inline-flex items-center justify-center rounded-md text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          <X size={14} />
        </button>
      ) : (
        <div className="w-9" />
      )}
    </div>
  );
}

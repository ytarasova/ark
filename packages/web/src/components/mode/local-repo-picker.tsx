/**
 * LocalRepoPicker -- repository picker for local-mode Ark builds.
 *
 * In local mode, the user's filesystem is reachable: they can type an
 * absolute path, pick from "recent repositories", or click "Browse for
 * folder..." to open a modal picker. No validation on input -- any string
 * that doesn't crash `path.resolve` is fine; the conductor resolves against
 * the local FS.
 */

import { useState } from "react";
import { cn } from "../../lib/utils.js";
import { FolderOpen } from "lucide-react";
import { RepoPickerShell } from "./repo-picker-shell.js";
import type { RepoPickerProps } from "./binding-types.js";

export function LocalRepoPicker({ value, onChange, recentRepos, onBrowse }: RepoPickerProps) {
  const [error, setError] = useState<string | null>(null);

  function tryCommit(raw: string) {
    const v = raw.trim();
    if (!v) return;
    setError(null);
    onChange(v);
  }

  return (
    <RepoPickerShell
      value={value}
      onCommit={tryCommit}
      visibleRecent={recentRepos}
      placeholder="Type path or search..."
      error={error}
      onClearError={() => setError(null)}
      footer={
        <div className="border-t border-[var(--border)] mt-1 pt-1">
          <button
            type="button"
            onClick={onBrowse}
            className={cn(
              "flex items-center gap-2 w-full text-left px-2.5 py-2 rounded-[var(--radius-sm,4px)]",
              "hover:bg-[var(--bg-hover)] transition-colors duration-100 cursor-pointer",
              "text-[12px] text-[var(--fg-muted)]",
            )}
          >
            <FolderOpen size={13} />
            Browse for folder...
          </button>
        </div>
      }
    />
  );
}

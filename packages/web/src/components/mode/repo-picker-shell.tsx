/**
 * Presentational shell shared between `LocalRepoPicker` and `HostedRepoPicker`.
 *
 * Owns the Popover layout, the search input, the recent-repos list rendering,
 * and the error slot. The two variants plug in their own placeholder, commit
 * validator, recent filter, and an optional "Browse" footer.
 */

import { useState, useRef, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "../../lib/utils.js";
import { formatRepoName } from "../../util.js";
import { FolderOpen, ChevronDown, Search, Folder } from "lucide-react";
import type { RecentRepo } from "./binding-types.js";

const triggerClass = cn(
  "flex items-center justify-between w-full h-9 px-3 rounded-md",
  "border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] text-[13px]",
  "hover:border-[var(--fg-muted)] transition-colors duration-150 cursor-pointer",
  "outline-none focus:ring-2 focus:ring-[var(--primary)]",
);

const popoverContentClass = cn(
  "w-[var(--radix-popover-trigger-width)] max-h-[300px] overflow-y-auto",
  "rounded-md border border-[var(--border)] bg-[var(--bg-card,var(--bg))] shadow-lg",
  "p-1 z-50",
);

export interface RepoPickerShellProps {
  value: string;
  onCommit: (raw: string) => void;
  /** Repos to offer after any mode-specific filtering has already been applied. */
  visibleRecent: RecentRepo[];
  placeholder: string;
  error: string | null;
  onClearError: () => void;
  /** Slot rendered under the recent-list (e.g. the "Browse" footer in local mode). */
  footer?: ReactNode;
}

export function RepoPickerShell({
  value,
  onCommit,
  visibleRecent,
  placeholder,
  error,
  onClearError,
  footer,
}: RepoPickerShellProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = search
    ? visibleRecent.filter(
        (r) =>
          r.path.toLowerCase().includes(search.toLowerCase()) ||
          r.basename.toLowerCase().includes(search.toLowerCase()),
      )
    : visibleRecent;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setTimeout(() => inputRef.current?.focus(), 50);
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" className={triggerClass}>
          <FolderOpen size={14} className="text-[var(--fg-muted)] shrink-0 mr-2" />
          <span className="truncate text-left flex-1">
            {value && value !== "." ? (
              <>
                <span className="font-medium">{formatRepoName(value)}</span>
                <span className="text-[var(--fg-muted)] ml-1.5 text-[12px]">{value}</span>
              </>
            ) : (
              <span className="text-[var(--fg-muted)]">Select repository...</span>
            )}
          </span>
          <ChevronDown size={14} className="text-[var(--fg-muted)] shrink-0 ml-2" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={4} align="start" className={popoverContentClass}>
          <div className="px-2 py-1.5 border-b border-[var(--border)]">
            <div className="flex items-center gap-1.5">
              <Search size={12} className="text-[var(--fg-muted)] shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  if (error) onClearError();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && search.trim()) {
                    onCommit(search);
                    setSearch("");
                    setOpen(false);
                  }
                }}
                placeholder={placeholder}
                aria-label="Repository path"
                className="w-full bg-transparent text-[12px] text-[var(--fg)] outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] rounded-[4px] placeholder:text-[var(--fg-faint)]"
              />
            </div>
          </div>

          {filtered.length > 0 && (
            <>
              <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold text-[var(--fg-muted)] uppercase tracking-wider">
                Recent repositories
              </div>
              {filtered.map((r) => (
                <button
                  key={r.path}
                  type="button"
                  onClick={() => {
                    onCommit(r.path);
                    setOpen(false);
                    setSearch("");
                  }}
                  className={cn(
                    "flex items-center gap-2 w-full text-left px-2.5 py-1.5 rounded-[var(--radius-sm,4px)]",
                    "hover:bg-[var(--bg-hover)] transition-colors duration-100 cursor-pointer",
                    value === r.path && "bg-[var(--primary)]/5",
                  )}
                >
                  <Folder size={13} className="text-[var(--fg-muted)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-[var(--fg)] truncate">{r.basename}</div>
                    <div className="text-[11px] text-[var(--fg-muted)] truncate">{r.path}</div>
                  </div>
                  <span className="text-[10px] text-[var(--fg-muted)] shrink-0 ml-1">{r.lastUsed}</span>
                </button>
              ))}
            </>
          )}

          {filtered.length === 0 && search && (
            <div className="px-3 py-3 text-[12px] text-[var(--fg-muted)] text-center">
              No matches. Press Enter to use "{search}"
            </div>
          )}

          {error && <div className="px-3 py-2 text-[11px] text-[var(--failed)]">{error}</div>}

          {footer}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

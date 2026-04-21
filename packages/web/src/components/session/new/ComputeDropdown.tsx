import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, Monitor } from "lucide-react";
import { cn } from "../../../lib/utils.js";
import { type ComputeInfo, triggerClass, popoverContentClass } from "./types.js";

function KindBadge({ c }: { c: ComputeInfo }) {
  return (
    <span
      className={cn(
        "text-[9px] px-1.5 py-[1px] rounded-full font-mono uppercase tracking-wider",
        c.is_template ? "bg-[var(--primary)]/15 text-[var(--primary)]" : "bg-[var(--running)]/15 text-[var(--running)]",
      )}
    >
      {c.is_template ? "Template" : "Running"}
    </span>
  );
}

/**
 * Popover dropdown that picks one compute target from `computes`. Hides
 * stopped / failed concrete targets because dispatching to them would fail
 * immediately -- only templates (clone-on-dispatch) and already-running
 * concrete targets are shown.
 */
export function ComputeDropdown({
  computes,
  selected,
  onSelect,
}: {
  computes: ComputeInfo[];
  selected: string;
  onSelect: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = computes.find((c) => c.name === selected);
  const dispatchable = computes.filter((c) => c.is_template || c.status === "running");

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={triggerClass}>
          <Monitor size={14} className="text-[var(--fg-muted)] shrink-0 mr-2" />
          <span className="truncate text-left flex-1 flex items-center gap-2">
            {current ? (
              <>
                <span className="font-medium">{current.name}</span>
                <KindBadge c={current} />
                {current.provider && <span className="text-[var(--fg-muted)] text-[12px]">{current.provider}</span>}
              </>
            ) : (
              <span className="text-[var(--fg-muted)]">Select compute...</span>
            )}
          </span>
          <ChevronDown size={14} className="text-[var(--fg-muted)] shrink-0 ml-2" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={4} align="start" className={popoverContentClass}>
          {dispatchable.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => {
                onSelect(c.name);
                setOpen(false);
              }}
              className={cn(
                "flex items-center gap-2 w-full text-left px-2.5 py-2 rounded-[var(--radius-sm,4px)]",
                "hover:bg-[var(--bg-hover)] transition-colors duration-100 cursor-pointer",
                selected === c.name && "bg-[var(--primary)]/5",
              )}
            >
              <div className="w-4 shrink-0">
                {selected === c.name && <Check size={14} className="text-[var(--primary)]" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-[var(--fg)]">{c.name}</span>
                  <KindBadge c={c} />
                </div>
                {(c.provider || c.type) && (
                  <div className="text-[11px] text-[var(--fg-muted)]">{c.provider || c.type}</div>
                )}
              </div>
            </button>
          ))}
          {dispatchable.length === 0 && (
            <div className="px-3 py-4 text-[12px] text-[var(--fg-muted)] text-center">
              No dispatchable computes. Start a concrete target or create a template first.
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

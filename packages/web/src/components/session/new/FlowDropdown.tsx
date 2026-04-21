import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../../lib/utils.js";
import { type FlowInfo, triggerClass, popoverContentClass } from "./types.js";

/**
 * Popover dropdown that picks one flow from `flows`. Shows the selected
 * flow's name + description inline in the trigger and renders stage
 * previews under each option.
 */
export function FlowDropdown({
  flows,
  selected,
  onSelect,
}: {
  flows: FlowInfo[];
  selected: string;
  onSelect: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = flows.find((f) => f.name === selected);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={triggerClass}>
          <span className="truncate text-left flex-1">
            {current ? (
              <>
                <span className="font-medium">{current.name}</span>
                {current.description && (
                  <span className="text-[var(--fg-muted)] ml-1.5 text-[12px]">-- {current.description}</span>
                )}
              </>
            ) : (
              <span className="text-[var(--fg-muted)]">Select a flow...</span>
            )}
          </span>
          <ChevronDown size={14} className="text-[var(--fg-muted)] shrink-0 ml-2" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={4} align="start" className={popoverContentClass}>
          {flows.map((f) => (
            <button
              key={f.name}
              type="button"
              onClick={() => {
                onSelect(f.name);
                setOpen(false);
              }}
              className={cn(
                "flex items-start gap-2 w-full text-left px-2.5 py-2 rounded-[var(--radius-sm,4px)]",
                "hover:bg-[var(--bg-hover)] transition-colors duration-100 cursor-pointer",
                selected === f.name && "bg-[var(--primary)]/5",
              )}
            >
              <div className="w-4 pt-0.5 shrink-0">
                {selected === f.name && <Check size={14} className="text-[var(--primary)]" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-medium text-[var(--fg)]">{f.name}</div>
                {f.description && (
                  <div className="text-[12px] text-[var(--fg-muted)] mt-0.5 line-clamp-2">{f.description}</div>
                )}
                {f.stages && f.stages.length > 0 && (
                  <div className="text-[10px] text-[var(--fg-muted)] mt-1 font-mono">
                    {f.stages.length} stages: {f.stages.join(" > ")}
                  </div>
                )}
              </div>
            </button>
          ))}
          {flows.length === 0 && (
            <div className="px-3 py-4 text-[12px] text-[var(--fg-muted)] text-center">No flows available</div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

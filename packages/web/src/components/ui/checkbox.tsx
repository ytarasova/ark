import { forwardRef } from "react";
import { cn } from "../../lib/utils.js";

/**
 * Checkbox atom -- per /tmp/ark-design-system/preview/form-checkbox-radio.html
 *
 *   14x14 rounded-4 inset bg #0a0a12, border var(--border)
 *   on  -> bg primary, white check (10px svg stroke 3)
 *   indeterminate -> bg primary, 7x2 white bar
 */
export interface CheckboxProps extends Omit<React.ComponentProps<"input">, "type"> {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  indeterminate?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, hint, indeterminate, checked, disabled, className, ...props }, ref) => {
    const on = !!checked;
    return (
      <label
        className={cn(
          "inline-flex items-center gap-[8px] font-[family-name:var(--font-sans)] text-[12px] font-medium text-[var(--fg)] cursor-pointer select-none",
          disabled && "opacity-40 cursor-not-allowed",
          className,
        )}
      >
        <input ref={ref} type="checkbox" checked={checked} disabled={disabled} className="sr-only peer" {...props} />
        <span
          aria-hidden
          className={cn(
            "relative w-[14px] h-[14px] rounded-[4px] grid place-items-center shrink-0",
            "bg-[#0a0a12] border border-[var(--border)]",
            "shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)]",
            "transition-[background,border-color] duration-[120ms]",
            (on || indeterminate) && [
              "bg-[var(--primary)] border-[rgba(0,0,0,0.25)]",
              "shadow-[0_1px_2px_rgba(0,0,0,0.25)]",
            ],
          )}
        >
          {indeterminate ? (
            <span className="block w-[7px] h-[2px] rounded-[1px] bg-[var(--primary-fg,white)]" />
          ) : (
            <svg
              viewBox="0 0 24 24"
              width={10}
              height={10}
              fill="none"
              stroke="var(--primary-fg, white)"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={cn("transition-opacity duration-[120ms]", on ? "opacity-100" : "opacity-0")}
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </span>
        {label}
        {hint && (
          <span className="font-[family-name:var(--font-mono-ui)] text-[10px] font-normal uppercase tracking-[0.04em] text-[var(--fg-faint)] ml-[2px]">
            {hint}
          </span>
        )}
      </label>
    );
  },
);
Checkbox.displayName = "Checkbox";

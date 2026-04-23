import { cn } from "../../lib/utils.js";

/**
 * Toggle (switch) atom -- per /tmp/ark-design-system/preview/form-checkbox-radio.html
 *
 *   28x16 pill track, 12x12 knob (gradient metal), on=primary bg.
 */
export interface ToggleProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
  id?: string;
}

export function Toggle({ checked, onChange, disabled, label, hint, className, id }: ToggleProps) {
  const on = !!checked;
  return (
    <label
      htmlFor={id}
      className={cn(
        "inline-flex items-center gap-[8px] font-[family-name:var(--font-sans)] text-[12px] font-medium text-[var(--fg)] select-none",
        disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer",
        className,
      )}
    >
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={on}
        disabled={disabled}
        onClick={() => onChange?.(!on)}
        className={cn(
          "relative inline-block w-[28px] h-[16px] rounded-full shrink-0",
          "bg-[#0a0a12] border border-[var(--border)]",
          "shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)]",
          "transition-[background,border-color] duration-[120ms]",
          on && "bg-[var(--primary)] border-[rgba(0,0,0,0.25)] shadow-[0_1px_2px_rgba(0,0,0,0.25)]",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "absolute top-1/2 -translate-y-1/2 w-[12px] h-[12px] rounded-full",
            "bg-[linear-gradient(180deg,#e4e4ed_0%,#c4c4d0_100%)]",
            "shadow-[0_1px_2px_rgba(0,0,0,0.5),inset_0_0.5px_0_rgba(255,255,255,0.3)]",
            "transition-[left] duration-[120ms]",
            on ? "left-[13px]" : "left-[1px]",
          )}
        />
      </button>
      {label}
      {hint && (
        <span className="font-[family-name:var(--font-mono-ui)] text-[10px] font-normal uppercase tracking-[0.04em] text-[var(--fg-faint)] ml-[2px]">
          {hint}
        </span>
      )}
    </label>
  );
}

import { forwardRef } from "react";
import { cn } from "../../lib/utils.js";

/**
 * Radio atom -- per /tmp/ark-design-system/preview/form-checkbox-radio.html
 *
 *   14x14 round inset bg, 6x6 primary dot centered when checked.
 */
export interface RadioProps extends Omit<React.ComponentProps<"input">, "type"> {
  label?: React.ReactNode;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(
  ({ label, checked, disabled, className, ...props }, ref) => {
    const on = !!checked;
    return (
      <label
        className={cn(
          "inline-flex items-center gap-[8px] font-[family-name:var(--font-sans)] text-[12px] font-medium text-[var(--fg)] cursor-pointer select-none",
          disabled && "opacity-40 cursor-not-allowed",
          className,
        )}
      >
        <input ref={ref} type="radio" checked={checked} disabled={disabled} className="sr-only peer" {...props} />
        <span
          aria-hidden
          className={cn(
            "relative w-[14px] h-[14px] rounded-full grid place-items-center shrink-0",
            "bg-[#0a0a12] border border-[var(--border)]",
            "shadow-[inset_0_1px_2px_rgba(0,0,0,0.5)]",
            on && "border-[rgba(107,89,222,0.5)]",
            "transition-[border-color] duration-[120ms]",
          )}
        >
          <span
            className={cn(
              "block w-[6px] h-[6px] rounded-full bg-[var(--primary)]",
              "shadow-[0_0_6px_rgba(107,89,222,0.5)]",
              "transition-opacity duration-[120ms]",
              on ? "opacity-100" : "opacity-0",
            )}
          />
        </span>
        {label}
      </label>
    );
  },
);
Radio.displayName = "Radio";

export function RadioGroup({
  name,
  value,
  onChange,
  options,
  className,
  disabled,
}: {
  name: string;
  value?: string;
  onChange?: (v: string) => void;
  options: Array<{ value: string; label: React.ReactNode; disabled?: boolean }>;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-[18px]", className)} role="radiogroup">
      {options.map((opt) => (
        <Radio
          key={opt.value}
          name={name}
          value={opt.value}
          checked={value === opt.value}
          onChange={() => onChange?.(opt.value)}
          disabled={disabled || opt.disabled}
          label={opt.label}
        />
      ))}
    </div>
  );
}

import { forwardRef } from "react";
import { cn } from "../../lib/utils.js";

/**
 * Input atom — rebuilt from /tmp/ark-design-system/preview/form-input-text.html
 * and /tmp/ark-design-system/preview/form-input-states.html.
 *
 * Surface: inset/recessed (not raised).
 *   h-32  px-11  radius 6  bg #0a0a12
 *   border 1px var(--border)
 *   shadow   0 1px 2px rgba(0,0,0,.5) inset,  0 1px 0 rgba(255,255,255,.02)
 *   font     sans 12 500 tracking -0.005em
 *   placeholder fg-faint
 *
 * Focus ring:  border var(--primary), 0 0 0 3px rgba(107,89,222,.18)
 * Invalid:     border #f87171, 0 0 0 3px rgba(248,113,113,.12)
 *
 * Back-compat: the old Input accepted plain <input> props and put every class
 * on the element directly. We keep that call-shape working and additionally
 * expose `InputShell` for the "labelled container with adornments" composition
 * the previews demonstrate.
 */

export interface InputProps extends React.ComponentProps<"input"> {
  invalid?: boolean;
}

const Input = forwardRef<HTMLInputElement, InputProps>(({ className, invalid, ...props }, ref) => {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "flex h-[32px] w-full rounded-[6px] px-[11px]",
        "bg-[#0a0a12] border border-[var(--border)]",
        "shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_1px_0_rgba(255,255,255,0.02)]",
        "font-[family-name:var(--font-sans)] text-[12px] font-medium tracking-[-0.005em]",
        "text-[var(--fg)] outline-none transition-[border-color,box-shadow,background] duration-[120ms]",
        "placeholder:text-[var(--fg-faint)]",
        "hover:border-[#33334d] hover:bg-[#0d0d18]",
        "focus:border-[var(--primary)] focus:bg-[#0d0d18]",
        "focus:shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_0_0_3px_rgba(107,89,222,0.18)]",
        "focus:caret-[var(--primary)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        invalid && [
          "border-[#f87171]",
          "shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_0_0_3px_rgba(248,113,113,0.12)]",
          "focus:border-[#f87171]",
          "focus:shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_0_0_3px_rgba(248,113,113,0.12)]",
        ],
        className,
      )}
      {...props}
    />
  );
});
Input.displayName = "Input";

/**
 * Shell variant for inputs that need leading/trailing adornments (prefix,
 * validation chip, spinner…). Matches the `<label class="input">` pattern
 * in the previews.
 */
export interface InputShellProps extends React.ComponentProps<"label"> {
  state?: "default" | "focus" | "valid" | "warn" | "error" | "disabled" | "readonly" | "loading";
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  inputProps?: React.ComponentProps<"input">;
}

export function InputShell({ state = "default", leading, trailing, inputProps, className, ...props }: InputShellProps) {
  return (
    <label
      className={cn(
        "relative flex items-center gap-2 h-[32px] px-[11px] rounded-[6px] overflow-hidden",
        "bg-[#0a0a12] border border-[var(--border)]",
        "shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_1px_0_rgba(255,255,255,0.02)]",
        "transition-[border-color,background,box-shadow] duration-[120ms]",
        "hover:border-[#33334d] hover:bg-[#0d0d18]",
        state === "focus" && [
          "border-[var(--primary)] bg-[#0d0d18]",
          "shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_0_0_3px_rgba(107,89,222,0.18)]",
        ],
        state === "valid" && "border-[rgba(52,211,153,0.5)]",
        state === "warn" && "border-[#fbbf24]",
        state === "error" &&
          "border-[#f87171] shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_0_0_3px_rgba(248,113,113,0.12)]",
        state === "disabled" && "opacity-45 cursor-not-allowed",
        state === "readonly" && "bg-[rgba(0,0,0,0.15)] border-dashed",
        className,
      )}
      {...props}
    >
      {leading && <span className="text-[var(--fg-faint)] text-[10px] font-medium uppercase tracking-[0.04em] shrink-0 font-[family-name:var(--font-mono-ui)]">{leading}</span>}
      <input
        {...inputProps}
        className={cn(
          "flex-1 min-w-0 appearance-none border-0 outline-none bg-transparent",
          "font-[family-name:var(--font-sans)] text-[12px] font-medium tracking-[-0.005em] text-[var(--fg)]",
          "placeholder:text-[var(--fg-faint)]",
          inputProps?.className,
        )}
      />
      {trailing}
      {state === "loading" && (
        <span className="absolute bottom-0 left-[-30%] w-[30%] h-[1.5px] bg-[linear-gradient(90deg,transparent,var(--primary),transparent)] animate-[slideRight_1.2s_linear_infinite]" />
      )}
    </label>
  );
}

export { Input };

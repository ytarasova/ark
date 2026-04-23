import { forwardRef } from "react";
import { cn } from "../../lib/utils.js";

/**
 * Input atom -- rebuilt from /tmp/ark-design-system/preview/form-input-text.html
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
 * Valid:       border rgba(52,211,153,.5)
 * Warn:        border #fbbf24
 * Readonly:    bg rgba(0,0,0,.15), dashed border
 * Loading:     bottom shimmer bar via ::after
 *
 * Back-compat: plain Input still accepts <input> props. InputShell is the
 * "labelled container with adornments" composition. InputField wraps shell +
 * helper text per form-input-states.html.
 */

export type InputState =
  | "default"
  | "hover"
  | "focus"
  | "valid"
  | "warn"
  | "error"
  | "disabled"
  | "readonly"
  | "loading";

export interface InputProps extends React.ComponentProps<"input"> {
  invalid?: boolean;
}

const INPUT_BASE = cn(
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
  "disabled:cursor-not-allowed disabled:opacity-45",
);

const Input = forwardRef<HTMLInputElement, InputProps>(({ className, invalid, ...props }, ref) => {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        INPUT_BASE,
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
 * Underline variant -- per form-input-text.html `underline` row. No border,
 * just a bottom rule + `>` prompt prefix.
 */
export const InputUnderline = forwardRef<HTMLInputElement, InputProps>(({ className, ...props }, ref) => {
  return (
    <span className="flex items-center gap-[6px] h-[26px] border-b border-[var(--border)] pb-[2px] focus-within:border-[var(--primary)] transition-colors">
      <span aria-hidden className="text-[var(--fg-faint)] font-[family-name:var(--font-mono-ui)] text-[11px]">
        &rsaquo;
      </span>
      <input
        ref={ref}
        className={cn(
          "flex-1 min-w-0 appearance-none border-0 outline-none bg-transparent",
          "font-[family-name:var(--font-sans)] text-[12px] font-medium tracking-[-0.005em] text-[var(--fg)]",
          "placeholder:text-[var(--fg-faint)]",
          className,
        )}
        {...props}
      />
    </span>
  );
});
InputUnderline.displayName = "InputUnderline";

/**
 * Shell variant for inputs with leading/trailing adornments (prefix chip,
 * validation chip, spinner...). Matches the `<label class="input">` pattern
 * in the previews.
 */
export interface InputShellProps extends Omit<React.ComponentProps<"label">, "onChange"> {
  state?: InputState;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  inputProps?: React.ComponentProps<"input">;
}

export function InputShell({ state = "default", leading, trailing, inputProps, className, ...props }: InputShellProps) {
  return (
    <label
      className={cn(
        "relative flex items-center gap-[8px] h-[32px] px-[11px] rounded-[6px] overflow-hidden",
        "bg-[#0a0a12] border border-[var(--border)]",
        "shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_1px_0_rgba(255,255,255,0.02)]",
        "transition-[border-color,background,box-shadow] duration-[120ms]",
        "hover:border-[#33334d] hover:bg-[#0d0d18]",
        "focus-within:border-[var(--primary)] focus-within:bg-[#0d0d18]",
        "focus-within:shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_0_0_3px_rgba(107,89,222,0.18)]",
        state === "hover" && "border-[#33334d] bg-[#0d0d18]",
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
      {leading && (
        <span className="text-[var(--fg-faint)] text-[10px] font-medium uppercase tracking-[0.04em] shrink-0 font-[family-name:var(--font-mono-ui)] pr-[8px] border-r border-[var(--border)]">
          {leading}
        </span>
      )}
      <input
        {...inputProps}
        className={cn(
          "flex-1 min-w-0 appearance-none border-0 outline-none bg-transparent",
          "font-[family-name:var(--font-sans)] text-[12px] font-medium tracking-[-0.005em] text-[var(--fg)]",
          "placeholder:text-[var(--fg-faint)]",
          inputProps?.className,
        )}
      />
      {trailing && <span className="shrink-0 inline-grid place-items-center">{trailing}</span>}
      {state === "loading" && (
        <span className="absolute bottom-0 left-[-30%] w-[30%] h-[1.5px] bg-[linear-gradient(90deg,transparent,var(--primary),transparent)] animate-[slideRight_1.2s_linear_infinite]" />
      )}
    </label>
  );
}

/**
 * Small 12px icons matching the spec glyph set.
 */
export function CheckIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2.5} {...props}>
      <polyline points="20 6 9 17 4 12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function WarnIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2} {...props}>
      <path
        d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="12" y1="9" x2="12" y2="13" strokeLinecap="round" />
      <line x1="12" y1="17" x2="12.01" y2="17" strokeLinecap="round" />
    </svg>
  );
}

export function ErrorIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2} {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" strokeLinecap="round" />
      <line x1="9" y1="9" x2="15" y2="15" strokeLinecap="round" />
    </svg>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block w-[12px] h-[12px] rounded-full",
        "border-[1.5px] border-[var(--border)] border-t-[var(--primary)]",
        "animate-[spin_700ms_linear_infinite]",
        className,
      )}
    />
  );
}

/**
 * Helper text below input -- mono-ui 10px uppercase tracking 0.04em.
 * Color derives from `state`.
 */
export interface HelperTextProps extends React.ComponentProps<"div"> {
  state?: "default" | "ok" | "warn" | "err";
}

export function HelperText({ state = "default", className, children, ...props }: HelperTextProps) {
  return (
    <div
      className={cn(
        "font-[family-name:var(--font-mono-ui)] text-[10px] font-normal uppercase tracking-[0.04em] mt-[4px] pl-[2px]",
        state === "default" && "text-[var(--fg-faint)]",
        state === "ok" && "text-[#34d399]",
        state === "warn" && "text-[#fbbf24]",
        state === "err" && "text-[#f87171]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * InputField -- a shell + helper text composition for the full
 * "labelled input with validation feedback" pattern.
 */
export interface InputFieldProps {
  state?: InputState;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  helper?: React.ReactNode;
  helperState?: HelperTextProps["state"];
  inputProps?: React.ComponentProps<"input">;
  className?: string;
}

export function InputField({
  state = "default",
  leading,
  trailing,
  helper,
  helperState,
  inputProps,
  className,
}: InputFieldProps) {
  // auto-derive trailing adornment from state if not provided
  const autoTrailing =
    trailing ??
    (state === "valid" ? (
      <CheckIcon className="text-[#34d399]" />
    ) : state === "warn" ? (
      <WarnIcon className="text-[#fbbf24]" />
    ) : state === "error" ? (
      <ErrorIcon className="text-[#f87171]" />
    ) : state === "loading" ? (
      <Spinner />
    ) : undefined);
  const autoHelperState =
    helperState ?? (state === "valid" ? "ok" : state === "warn" ? "warn" : state === "error" ? "err" : "default");
  return (
    <div className={className}>
      <InputShell state={state} leading={leading} trailing={autoTrailing} inputProps={inputProps} />
      {helper != null && <HelperText state={autoHelperState}>{helper}</HelperText>}
    </div>
  );
}

export { Input };

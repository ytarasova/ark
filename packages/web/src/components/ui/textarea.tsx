import { forwardRef } from "react";
import { cn } from "../../lib/utils.js";

/**
 * Textarea atom -- per /tmp/ark-design-system/preview/form-input-textarea.html
 *
 * Surface mirrors Input: inset/recessed, same bg/border/shadow stack but
 * multi-line. Rounds to 8px instead of 6px per spec composer class.
 */
export interface TextareaProps extends React.ComponentProps<"textarea"> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, invalid, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "flex w-full min-h-[56px] rounded-[8px] px-[12px] py-[10px]",
        "bg-[#0a0a12] border border-[var(--border)]",
        "shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_1px_0_rgba(255,255,255,0.02)]",
        "font-[family-name:var(--font-sans)] text-[13px] font-medium leading-[20px] tracking-[-0.005em]",
        "text-[var(--fg)] outline-none resize-vertical transition-[border-color,box-shadow,background] duration-[120ms]",
        "placeholder:text-[var(--fg-faint)] placeholder:font-normal",
        "hover:border-[#33334d]",
        "focus:border-[var(--primary)] focus:bg-[#0d0d18]",
        "focus:shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_0_0_3px_rgba(107,89,222,0.15)]",
        "disabled:cursor-not-allowed disabled:opacity-45",
        invalid && [
          "border-[#f87171]",
          "focus:border-[#f87171]",
          "focus:shadow-[inset_0_1px_2px_rgba(0,0,0,0.5),0_0_0_3px_rgba(248,113,113,0.15)]",
        ],
        className,
      )}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

/**
 * StatusDot — rebuilt from the `.dot` + `.pip running` compositions that
 * appear in badges.html, chrome-session-list.html, chrome-session-header.html,
 * and app-chrome.html.
 *
 * Sizes    sm 5px   md 6px   lg 7px   xl 8px
 * Running  emits a glow + 1.6s pulse ring (`.pip.running::after` in the list card)
 * Failed   emits a fixed failed-glow
 */
const dotVariants = cva("inline-block rounded-full shrink-0 relative", {
  variants: {
    status: {
      running: "bg-[var(--running)] shadow-[var(--running-glow)]",
      waiting: "bg-[var(--waiting)]",
      completed: "bg-[var(--completed)]",
      failed: "bg-[var(--failed)] shadow-[var(--failed-glow)]",
      stopped: "bg-[var(--stopped)]",
      pending: "bg-[var(--stopped)] opacity-60",
    },
    size: {
      sm: "w-[5px] h-[5px]",
      md: "w-[6px] h-[6px]",
      lg: "w-[7px] h-[7px]",
      xl: "w-[8px] h-[8px]",
    },
  },
  defaultVariants: { status: "stopped", size: "md" },
});

export type SessionStatus = "running" | "waiting" | "completed" | "failed" | "stopped" | "pending";

export interface StatusDotProps extends React.ComponentProps<"span">, VariantProps<typeof dotVariants> {
  status: SessionStatus;
  /** Render a pulsing ring around a running dot (the `.pip.running::after` pulse). */
  pulse?: boolean;
}

export function StatusDot({ status, size, pulse, className, ...props }: StatusDotProps) {
  const showPulse = pulse && status === "running";
  return (
    <span role="status" aria-label={status} className={cn(dotVariants({ status, size }), className)} {...props}>
      {showPulse && (
        <span
          aria-hidden
          className="absolute inset-[-2px] rounded-full border border-[var(--running)] opacity-25"
          style={{ animation: "pulse 1.6s ease-out infinite" }}
        />
      )}
    </span>
  );
}

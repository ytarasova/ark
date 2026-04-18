import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const dotVariants = cva("rounded-full shrink-0", {
  variants: {
    status: {
      running: "bg-[var(--running)] shadow-[0_0_8px_rgba(96,165,250,0.4)]",
      waiting: "bg-[var(--waiting)]",
      completed: "bg-[var(--completed)] shadow-[0_0_4px_rgba(52,211,153,0.4)]",
      failed: "bg-[var(--failed)] shadow-[var(--failed-glow)]",
      stopped: "bg-[var(--stopped)]",
      pending: "bg-[var(--stopped)] opacity-60",
    },
    size: {
      sm: "w-[6px] h-[6px]",
      md: "w-[7px] h-[7px]",
      lg: "w-[8px] h-[8px]",
    },
  },
  defaultVariants: { status: "stopped", size: "md" },
});

export type SessionStatus = "running" | "waiting" | "completed" | "failed" | "stopped" | "pending";

export interface StatusDotProps extends React.ComponentProps<"span">, VariantProps<typeof dotVariants> {
  status: SessionStatus;
}

export function StatusDot({ status, size, className, ...props }: StatusDotProps) {
  return <span className={cn(dotVariants({ status, size }), className)} role="status" aria-label={status} {...props} />;
}

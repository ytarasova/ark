import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const findingVariants = cva("inline-flex items-center gap-1.5 text-[12px] leading-[1.5]", {
  variants: {
    severity: {
      good: "",
      note: "",
      issue: "",
    },
  },
  defaultVariants: { severity: "note" },
});

const badgeVariants = cva(
  "inline-flex items-center px-1.5 py-[1px] rounded text-[10px] font-medium uppercase tracking-[0.04em]",
  {
    variants: {
      severity: {
        good: "bg-[rgba(52,211,153,0.12)] text-[var(--running)]",
        note: "bg-[rgba(96,165,250,0.12)] text-[var(--completed)]",
        issue: "bg-[rgba(248,113,113,0.12)] text-[var(--failed)]",
      },
    },
    defaultVariants: { severity: "note" },
  },
);

export interface ReviewFindingProps extends React.ComponentProps<"div">, VariantProps<typeof findingVariants> {
  severity: "good" | "note" | "issue";
  children: React.ReactNode;
}

/**
 * Review finding badge + text for code review results.
 */
export function ReviewFinding({ severity, children, className, ...props }: ReviewFindingProps) {
  return (
    <div className={cn(findingVariants({ severity }), className)} {...props}>
      <span className={badgeVariants({ severity })}>{severity}</span>
      <span>{children}</span>
    </div>
  );
}

import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const avatarVariants = cva("inline-flex items-center justify-center rounded-full font-semibold shrink-0 text-white", {
  variants: {
    size: {
      sm: "w-[18px] h-[18px] text-[9px]",
      md: "w-[22px] h-[22px] text-[10px]",
      lg: "w-[28px] h-[28px] text-[11px]",
    },
  },
  defaultVariants: { size: "md" },
});

export interface AvatarProps extends React.ComponentProps<"span">, VariantProps<typeof avatarVariants> {
  name: string;
  color?: string;
}

const ROLE_COLORS: Record<string, string> = {
  planner: "#7c6aef",
  implementer: "#3b82f6",
  reviewer: "#f59e0b",
  verifier: "#34d399",
  merger: "#a78bfa",
  user: "var(--primary)",
};

export function Avatar({ name, color, size, className, style, ...props }: AvatarProps) {
  const bg = color ?? ROLE_COLORS[name.toLowerCase()] ?? "var(--primary)";
  const initial = name.charAt(0).toUpperCase();

  return (
    <span className={cn(avatarVariants({ size }), className)} style={{ background: bg, ...style }} {...props}>
      {initial}
    </span>
  );
}

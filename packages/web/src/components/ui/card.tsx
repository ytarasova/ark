import { cn } from "../../lib/utils.js";

/**
 * Card — rebuilt from `/tmp/ark-design-system/preview/cards-session.html`.
 *
 * Surface is "tangible": uses an overlay gradient for top-lit lighting,
 * differentiated border colors (lighter on top, darker on bottom), and a
 * layered box-shadow to suggest elevation.
 *
 * Variants:
 *   default   flat tangible surface (padding 13px 14px)
 *   elevated  adds a stronger shadow stack
 *   active    adds primary-tinted border + left-edge accent stripe + outer
 *             primary glow ring. Use for "this is the selected card".
 */
export interface CardProps extends React.ComponentProps<"div"> {
  variant?: "default" | "elevated";
  active?: boolean;
}

function Card({ className, variant = "default", active, style, ...props }: CardProps) {
  return (
    <div
      className={cn(
        "relative rounded-[9px] border",
        "border-[var(--border)] border-t-[rgba(255,255,255,0.07)] border-b-[rgba(0,0,0,0.5)]",
        "text-[var(--fg)]",
        variant === "elevated"
          ? "shadow-[inset_0_1px_0_rgba(255,255,255,0.06),inset_0_-1px_0_rgba(0,0,0,0.5),0_2px_3px_rgba(0,0,0,0.6),0_16px_30px_-8px_rgba(0,0,0,0.55)]"
          : "shadow-[inset_0_1px_0_rgba(255,255,255,0.04),inset_0_-1px_0_rgba(0,0,0,0.4),0_1px_2px_rgba(0,0,0,0.4),0_8px_18px_-4px_rgba(0,0,0,0.4)]",
        active && [
          "!border-[rgba(107,89,222,0.45)] !border-t-[rgba(147,130,255,0.55)]",
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.06),inset_0_-1px_0_rgba(0,0,0,0.4),0_0_0_3px_rgba(107,89,222,0.1),0_2px_4px_rgba(0,0,0,0.4),0_12px_28px_-6px_rgba(107,89,222,0.2)]",
        ],
        className,
      )}
      style={{
        background:
          "linear-gradient(180deg, rgba(255,255,255,.025) 0%, rgba(255,255,255,0) 25%, rgba(0,0,0,.15) 100%), var(--bg-card)",
        ...style,
      }}
      {...props}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-[14px] bottom-[14px] w-[2px] rounded-r-[2px] bg-[linear-gradient(180deg,#a78bfa,var(--primary))] shadow-[0_0_8px_rgba(107,89,222,0.6)]"
        />
      )}
      {props.children}
    </div>
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5 px-[14px] pt-[13px]", className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      className={cn(
        "font-[family-name:var(--font-sans)] text-[14px] leading-[19px] font-semibold text-[var(--fg)] tracking-[-0.01em]",
        className,
      )}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-[12px] text-[var(--fg-muted)]", className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-[14px] py-[9px]", className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent };

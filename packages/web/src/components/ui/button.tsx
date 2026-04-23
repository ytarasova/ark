import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

/**
 * Button atom — rebuilt against /tmp/ark-design-system/preview/buttons.html.
 *
 * Geometry (from the preview):
 *   default  h-32  px-13  font-sans 12px 500  tracking -0.005em  radius 6
 *   sm       h-26  px-11  font-sans 11px 500
 *   icon     32x32 square (sm-icon 26x26)
 *
 * Variants (exact hex where the preview names one, opacity tricks retired):
 *   primary    bg var(--primary)         hover #7d6be8  active #5f4ed0
 *              border rgba(0,0,0,.25)    shadow 0 1px 2px rgba(0,0,0,.25)
 *   secondary  bg #1e1e30                hover #24243a  active #1a1a28
 *              border var(--border)      shadow 0 1px 2px rgba(0,0,0,.2)
 *   ghost      bg transparent            hover bg var(--bg-hover) / fg var(--fg)
 *   danger     bg rgba(248,113,113,.06)  border rgba(248,113,113,.35)  color #f87171
 *              hover bg rgba(248,113,113,.12) / border rgba(248,113,113,.55)
 *
 * Icon glyph size inside button is 13px per the preview.
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0",
    "rounded-[6px] border cursor-pointer",
    "font-[family-name:var(--font-sans)] text-[12px] font-medium tracking-[-0.005em]",
    "transition-[background-color,border-color,filter,transform] duration-[120ms]",
    "active:translate-y-[0.5px]",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:w-[13px] [&_svg]:h-[13px] [&_svg]:shrink-0",
    "outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-0",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: [
          "bg-[var(--primary)] text-[var(--primary-fg)]",
          "border-[rgba(0,0,0,0.25)]",
          "shadow-[0_1px_2px_rgba(0,0,0,0.25)]",
          "hover:bg-[#7d6be8]",
          "active:bg-[#5f4ed0]",
        ].join(" "),
        secondary: [
          "bg-[#1e1e30] text-[var(--fg)]",
          "border-[var(--border)]",
          "shadow-[0_1px_2px_rgba(0,0,0,0.2)]",
          "hover:bg-[#24243a] hover:border-[var(--border-light)]",
          "active:bg-[#1a1a28]",
        ].join(" "),
        ghost: [
          "bg-transparent border-transparent text-[var(--fg-muted)]",
          "hover:bg-[var(--bg-hover)] hover:text-[var(--fg)]",
        ].join(" "),
        danger: [
          "bg-[rgba(248,113,113,0.06)] text-[#f87171]",
          "border-[rgba(248,113,113,0.35)]",
          "shadow-[0_1px_2px_rgba(0,0,0,0.2)]",
          "hover:bg-[rgba(248,113,113,0.12)] hover:border-[rgba(248,113,113,0.55)]",
        ].join(" "),
        /** alias kept for migration -- behaves like `primary`. */
        default: [
          "bg-[var(--primary)] text-[var(--primary-fg)]",
          "border-[rgba(0,0,0,0.25)]",
          "shadow-[0_1px_2px_rgba(0,0,0,0.25)]",
          "hover:bg-[#7d6be8]",
          "active:bg-[#5f4ed0]",
        ].join(" "),
        /** alias kept for migration -- behaves like `danger`. */
        destructive: [
          "bg-[rgba(248,113,113,0.06)] text-[#f87171]",
          "border-[rgba(248,113,113,0.35)]",
          "shadow-[0_1px_2px_rgba(0,0,0,0.2)]",
          "hover:bg-[rgba(248,113,113,0.12)] hover:border-[rgba(248,113,113,0.55)]",
        ].join(" "),
        /** alias kept for migration -- behaves like `secondary`. */
        outline: [
          "bg-[#1e1e30] text-[var(--fg)]",
          "border-[var(--border)]",
          "shadow-[0_1px_2px_rgba(0,0,0,0.2)]",
          "hover:bg-[#24243a] hover:border-[var(--border-light)]",
          "active:bg-[#1a1a28]",
        ].join(" "),
        link: "bg-transparent border-transparent text-[var(--primary)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-[32px] px-[13px]",
        sm: "h-[26px] px-[11px] text-[11px]",
        lg: "h-[36px] px-[16px]",
        icon: "h-[32px] w-[32px] p-0",
        "icon-sm": "h-[26px] w-[26px] p-0",
        "icon-xs": "h-[22px] w-[22px] p-0",
        xs: "h-[22px] px-[8px] text-[10px]",
      },
    },
    defaultVariants: { variant: "primary", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };

import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

/**
 * Badge atoms — rebuilt from /tmp/ark-design-system/preview/badges.html.
 *
 * The design system has TWO distinct shapes, not one:
 *
 *   1. StatusBadge  -- pill-shaped (rounded-full), 22px high, gradient background
 *      with inset gloss + drop shadow, renders a 6px colored dot beside the
 *      label. Used for session/run state: running/waiting/completed/failed/stopped.
 *
 *   2. TagChip      -- rounded (radius 5), 22px high, dark matte gradient
 *      (#222238 -> #1a1a2b), mono-ui 10px UPPERCASE letter-spaced 0.05em.
 *      Used for runtime + compute chips. `variant="primary"` switches the
 *      gradient to purple + lavender text for agent chips. `lowercase` disables
 *      the uppercase transform (compute names display as-is).
 *
 * The legacy `Badge` export is kept for back-compat call sites that used
 * variant-based flat pills; it now delegates to StatusBadge for semantic states
 * and to TagChip for tag-style labels.
 */

// ──────────────────────────────────────────────────────────────────────────
// StatusBadge -- pill, gradient, live dot
// ──────────────────────────────────────────────────────────────────────────

const STATUS_STYLES = {
  running: {
    bg: "linear-gradient(180deg, rgba(96,165,250,.16), rgba(96,165,250,.06))",
    color: "#7dbbff",
    border: "rgba(96,165,250,.32)",
    dot: "#60a5fa",
    dotGlow: "0 0 5px rgba(96,165,250,.6)",
  },
  waiting: {
    bg: "linear-gradient(180deg, rgba(251,191,36,.13), rgba(251,191,36,.04))",
    color: "#fbbf24",
    border: "rgba(251,191,36,.3)",
    dot: "#fbbf24",
    dotGlow: "",
  },
  completed: {
    bg: "linear-gradient(180deg, rgba(52,211,153,.13), rgba(52,211,153,.04))",
    color: "#34d399",
    border: "rgba(52,211,153,.3)",
    dot: "#34d399",
    dotGlow: "",
  },
  failed: {
    bg: "linear-gradient(180deg, rgba(248,113,113,.13), rgba(248,113,113,.04))",
    color: "#f87171",
    border: "rgba(248,113,113,.32)",
    dot: "#f87171",
    dotGlow: "",
  },
  stopped: {
    bg: "linear-gradient(180deg, rgba(255,255,255,.02), rgba(0,0,0,.08))",
    color: "var(--fg-muted)",
    border: "var(--border)",
    dot: "rgba(156,163,175,.4)",
    dotGlow: "",
  },
  pending: {
    bg: "linear-gradient(180deg, rgba(255,255,255,.02), rgba(0,0,0,.08))",
    color: "var(--fg-muted)",
    border: "var(--border)",
    dot: "rgba(156,163,175,.4)",
    dotGlow: "",
  },
} as const;

export type StatusBadgeStatus = keyof typeof STATUS_STYLES;

export interface StatusBadgeProps extends React.ComponentProps<"span"> {
  status: StatusBadgeStatus;
  /** Show the leading dot. Default true. */
  dot?: boolean;
}

export function StatusBadge({ status, dot = true, className, children, ...props }: StatusBadgeProps) {
  const s = STATUS_STYLES[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        "h-[22px] px-[9px] rounded-full",
        "font-[family-name:var(--font-sans)] text-[11px] font-medium leading-none",
        "border",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_1px_1.5px_rgba(0,0,0,0.25)]",
        className,
      )}
      style={{ background: s.bg, color: s.color, borderColor: s.border }}
      {...props}
    >
      {dot && (
        <span
          aria-hidden
          className="w-[6px] h-[6px] rounded-full shrink-0"
          style={{ background: s.dot, boxShadow: s.dotGlow || undefined }}
        />
      )}
      {children ?? status}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// TagChip -- runtime / compute / agent chip
// ──────────────────────────────────────────────────────────────────────────

const tagChipVariants = cva(
  [
    "inline-flex items-center gap-1.5",
    "h-[22px] px-[9px] rounded-[5px]",
    "font-[family-name:var(--font-mono-ui)] text-[10px] font-medium leading-none",
    "tracking-[0.05em]",
    "border border-[var(--border)]",
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_1px_1.5px_rgba(0,0,0,0.25)]",
  ].join(" "),
  {
    variants: {
      variant: {
        /** Runtime / compute: dark matte gradient + fg. */
        default: "bg-[linear-gradient(180deg,#222238_0%,#1a1a2b_100%)] text-[var(--fg)] border-[var(--border)]",
        /** Agent chip: purple gradient + lavender fg. */
        primary:
          "bg-[linear-gradient(180deg,rgba(139,122,255,0.25),rgba(107,89,222,0.12))] text-[#b0a3ff] border-[rgba(107,89,222,0.35)]",
      },
      /** Uppercase is the default per the spec (`rt` class). `none` disables it
          for compute names that should render lowercase (`local`, `ec2`…). */
      textCase: {
        upper: "uppercase",
        none: "normal-case tracking-[0.02em]",
      },
    },
    defaultVariants: { variant: "default", textCase: "upper" },
  },
);

export interface TagChipProps extends React.ComponentProps<"span">, VariantProps<typeof tagChipVariants> {}

export function TagChip({ variant, textCase, className, ...props }: TagChipProps) {
  return <span className={cn(tagChipVariants({ variant, textCase }), className)} {...props} />;
}

/** Semantic wrapper for agent name chips. */
export function AgentChip(props: React.ComponentProps<"span">) {
  return <TagChip variant="primary" textCase="upper" {...props} />;
}

/** Semantic wrapper for runtime chips (claude, codex, gemini, goose). */
export function RuntimeChip(props: React.ComponentProps<"span">) {
  return <TagChip variant="default" textCase="upper" {...props} />;
}

/** Semantic wrapper for compute chips (local, docker, ec2, k8s, firecracker).
 *  Compute names render lowercase per the preview. */
export function ComputeChip(props: React.ComponentProps<"span">) {
  return <TagChip variant="default" textCase="none" {...props} />;
}

// ──────────────────────────────────────────────────────────────────────────
// Legacy Badge -- kept for back-compat; delegates to the shapes above.
// ──────────────────────────────────────────────────────────────────────────

const legacyVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium font-mono uppercase tracking-wider",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/15 text-[var(--primary)]",
        secondary: "border-[var(--border)] bg-[var(--bg-hover)] text-[var(--fg-muted)]",
        destructive: "border-transparent bg-[rgba(248,113,113,0.12)] text-[var(--failed)]",
        success: "border-transparent bg-[rgba(52,211,153,0.12)] text-[var(--completed)]",
        warning: "border-transparent bg-[rgba(251,191,36,0.12)] text-[var(--waiting)]",
        info: "border-transparent bg-[rgba(96,165,250,0.12)] text-[var(--running)]",
        outline: "text-[var(--fg-muted)] border-[var(--border)]",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Badge({ className, variant, ...props }: React.ComponentProps<"span"> & VariantProps<typeof legacyVariants>) {
  return <span className={cn(legacyVariants({ variant, className }))} {...props} />;
}

export { Badge, legacyVariants as badgeVariants };

import { cn } from "../../lib/utils.js";

export interface IntegrationPillProps extends React.ComponentProps<"a"> {
  /** Lucide icon node or SVG element */
  icon?: React.ReactNode;
  /** Service label (e.g. "Jira", "GitHub PR", "CI") */
  label: string;
  /** Optional count or secondary text */
  count?: string | number;
}

/**
 * Clickable pill linking to an external service integration.
 */
export function IntegrationPill({ icon, label, count, className, ...props }: IntegrationPillProps) {
  return (
    <a
      className={cn(
        "inline-flex items-center gap-[5px] text-[11px] font-[var(--font-mono-ui)]",
        "px-2 py-[3px] rounded bg-[var(--bg-card)] border border-[var(--border)]",
        "text-[var(--fg-muted)] no-underline shrink-0 cursor-pointer",
        "hover:border-[var(--primary)] hover:text-[var(--fg)] transition-colors duration-150",
        "[&_svg]:w-3 [&_svg]:h-3",
        className,
      )}
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {icon}
      <span>{label}</span>
      {count != null && <span className="font-semibold text-[var(--fg)]">{count}</span>}
    </a>
  );
}

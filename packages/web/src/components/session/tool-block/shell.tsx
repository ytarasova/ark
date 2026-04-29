import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../../lib/utils.js";

/**
 * Tool block shell -- per /tmp/ark-design-system/preview/chrome-tool-block.html
 *
 * Three-part card: header (icon + name + args + status + elapsed),
 * body (tool-specific content), footer (mono-ui stats + primary action).
 */

/**
 * Tool block lifecycle states.
 *
 * - `running`: PreToolUse seen, waiting on PostToolUse. Spinner + stop affordance.
 * - `ok` / `err`: terminal -- both Pre and Post observed.
 * - `incomplete`: terminal but inconclusive. The session ended (timeout /
 *   stop / kill) before the tool emitted a PostToolUse. No spinner, no stop
 *   affordance, label reads "incomplete".
 */
export type ToolStatus = "running" | "ok" | "err" | "incomplete";

export interface ToolBlockShellProps {
  icon: React.ReactNode;
  name: string;
  arg?: React.ReactNode;
  status?: ToolStatus;
  statusLabel?: string;
  elapsed?: string;
  body: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Don't render the header background/border (used when body == url header). */
  plainBody?: boolean;
}

export function ToolBlockShell({
  icon,
  name,
  arg,
  status = "ok",
  statusLabel,
  elapsed,
  body,
  footer,
  className,
  bodyClassName,
  plainBody,
}: ToolBlockShellProps) {
  const label =
    statusLabel ??
    (status === "running" ? "running" : status === "err" ? "error" : status === "incomplete" ? "incomplete" : "ok");
  // Collapsed by default for finished tools so the session view is scannable;
  // running tools stay open so live output is visible. Users can toggle via
  // the chevron.
  const [open, setOpen] = useState(status === "running");
  return (
    <div
      className={cn(
        "my-[6px] rounded-[7px] overflow-hidden",
        "border border-[var(--border)] bg-[var(--bg-card)]",
        "shadow-[0_1px_2px_rgba(0,0,0,0.3)]",
        className,
      )}
    >
      {/* Header (clickable: toggles body) */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "w-full flex items-center gap-[8px] px-[11px] py-[7px] text-left",
          "bg-[rgba(0,0,0,0.2)] border-0 cursor-pointer hover:bg-[rgba(0,0,0,0.28)] transition-colors",
          open && "border-b border-[var(--border)]",
        )}
      >
        <ChevronRight
          size={12}
          strokeWidth={2}
          aria-hidden
          className={cn("text-[var(--fg-muted)] shrink-0 transition-transform duration-[120ms]", open && "rotate-90")}
        />
        <span
          aria-hidden
          className="w-[18px] h-[18px] rounded-[4px] grid place-items-center shrink-0 bg-[rgba(107,89,222,0.15)] text-[var(--primary)]"
        >
          {icon}
        </span>
        <span className="font-[family-name:var(--font-mono)] text-[11px] font-medium text-[var(--fg)] tracking-[-0.005em] shrink-0">
          {name}
        </span>
        <span className="font-[family-name:var(--font-mono)] text-[11px] font-medium text-[var(--fg-muted)] truncate flex-1 min-w-0">
          {arg}
        </span>
        <span
          className={cn(
            "font-[family-name:var(--font-mono-ui)] text-[10px] font-medium uppercase tracking-[0.05em] inline-flex items-center gap-[5px] shrink-0",
            status === "running" && "text-[var(--running)]",
            status === "ok" && "text-[var(--completed)]",
            status === "err" && "text-[var(--failed)]",
            status === "incomplete" && "text-[var(--fg-muted)]",
          )}
        >
          {status === "running" ? (
            <span
              aria-hidden
              className="w-[10px] h-[10px] rounded-full border-[1.5px] border-[rgba(96,165,250,0.2)] border-t-[var(--running)] animate-[spin_700ms_linear_infinite]"
            />
          ) : (
            <span aria-hidden className="w-[6px] h-[6px] rounded-full bg-current" />
          )}
          {label}
        </span>
        {elapsed && (
          <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--fg-faint)] shrink-0">
            {elapsed}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Body */}
          {plainBody ? (
            body
          ) : (
            <div
              className={cn(
                "px-[11px] py-[9px] bg-[var(--bg-code)]",
                "font-[family-name:var(--font-mono)] text-[12px] leading-[1.55] text-[var(--fg)]",
                "max-h-[220px] overflow-hidden relative",
                bodyClassName,
              )}
            >
              {body}
            </div>
          )}

          {/* Footer */}
          {footer && (
            <div className="flex items-center gap-[10px] px-[11px] py-[5px] border-t border-[var(--border)] bg-[rgba(0,0,0,0.15)] font-[family-name:var(--font-mono-ui)] text-[10px] font-medium text-[var(--fg-faint)] uppercase tracking-[0.05em]">
              {footer}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Inline footer stat: `key <b>value</b>` */
export function FootStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-[5px] text-[var(--fg-muted)]">
      {label}{" "}
      <b className="font-medium font-[family-name:var(--font-mono)] text-[var(--fg)] tracking-normal normal-case">
        {value}
      </b>
    </span>
  );
}

export function FootAction({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-[var(--primary)] font-[family-name:var(--font-mono)] normal-case tracking-normal cursor-pointer hover:underline"
    >
      {children}
    </button>
  );
}

export function FootSpacer() {
  return <span className="flex-1" />;
}

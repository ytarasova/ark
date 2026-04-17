import { cn } from "../lib/utils.js";

interface PageShellProps {
  title: string;
  headerLeft?: React.ReactNode;
  headerRight?: React.ReactNode;
  padded?: boolean;
  children: React.ReactNode;
}

/**
 * Inner shell for secondary pages (agents, flows, compute, etc.).
 * Provides a title bar + scrollable content area, rendered inside the new Layout.
 */
export function PageShell({ title, headerLeft, headerRight, padded = true, children }: PageShellProps) {
  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-[var(--bg)]">
      <div className="h-12 px-5 border-b border-[var(--border)] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-[15px] font-semibold text-[var(--fg)]">{title}</h1>
          {headerLeft}
        </div>
        <div className="flex items-center gap-3">{headerRight}</div>
      </div>
      <div className={cn("flex-1 overflow-y-auto flex flex-col", padded && "p-5 px-6")}>{children}</div>
    </div>
  );
}

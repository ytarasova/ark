import { cn } from "../../lib/utils.js";

export interface WorkspacePanelProps extends React.ComponentProps<"div"> {
  children: React.ReactNode;
}

/**
 * Right/main panel container for session detail content.
 * Wraps tab content with proper flex layout.
 */
export function WorkspacePanel({ children, className, ...props }: WorkspacePanelProps) {
  return (
    <div className={cn("flex-1 flex flex-col min-w-0 bg-[var(--bg)]", className)} {...props}>
      {children}
    </div>
  );
}

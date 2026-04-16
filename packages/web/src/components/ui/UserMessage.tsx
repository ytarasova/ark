import { cn } from "../../lib/utils.js";
import { Avatar } from "./Avatar.js";

export interface UserMessageProps extends React.ComponentProps<"div"> {
  timestamp?: string;
  children: React.ReactNode;
}

/**
 * A user message in the conversation view.
 * Avatar + "You" label + message in a highlighted bubble.
 */
export function UserMessage({ timestamp, children, className, ...props }: UserMessageProps) {
  return (
    <div className={cn("mb-5", className)} {...props}>
      <div className="flex items-center gap-2 mb-1">
        <Avatar name="You" size="md" />
        <span className="text-[13px] font-semibold">You</span>
        {timestamp && (
          <span className="text-[10px] text-[var(--fg-muted)] ml-auto font-[family-name:var(--font-mono-ui)]">
            {timestamp}
          </span>
        )}
      </div>
      <div
        className={cn(
          "ml-[30px] bg-[var(--bg-card)] border border-[var(--border)] rounded-lg",
          "px-3.5 py-2.5 text-[13px] leading-[1.6]",
          "[&_p]:mb-1.5 [&_p:last-child]:mb-0",
        )}
      >
        {children}
      </div>
    </div>
  );
}

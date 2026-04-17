import { cn } from "../../lib/utils.js";
import { Avatar } from "./Avatar.js";

export interface AgentMessageProps extends React.ComponentProps<"div"> {
  agentName: string;
  model?: string;
  timestamp?: string;
  avatarColor?: string;
  children: React.ReactNode;
}

/**
 * An agent message in the conversation view.
 * Shows avatar circle + agent name + model label + timestamp + message content.
 */
export function AgentMessage({
  agentName,
  model,
  timestamp,
  avatarColor,
  children,
  className,
  ...props
}: AgentMessageProps) {
  return (
    <div className={cn("mb-5", className)} {...props}>
      <div className="flex items-center gap-2 mb-1">
        <Avatar name={agentName} color={avatarColor} size="md" />
        <span className="text-[13px] font-semibold">{agentName}</span>
        {model && (
          <span className="font-[family-name:var(--font-mono-ui)] text-[10px] text-[var(--fg-muted)]">{model}</span>
        )}
        {timestamp && (
          <span className="text-[10px] text-[var(--fg-muted)] ml-auto font-[family-name:var(--font-mono-ui)]">
            {timestamp}
          </span>
        )}
      </div>
      <div className="pl-[30px] text-[13px] leading-[1.6] [&_p]:mb-1.5 [&_p:last-child]:mb-0">{children}</div>
    </div>
  );
}

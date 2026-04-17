import { cn } from "../../lib/utils.js";

export interface TypingIndicatorProps extends React.ComponentProps<"div"> {
  agentName?: string;
}

/**
 * Three bouncing dots with optional agent name, shown while an agent is typing.
 */
export function TypingIndicator({ agentName, className, ...props }: TypingIndicatorProps) {
  return (
    <div className={cn("flex items-center gap-2 pl-[30px] mt-2", className)} {...props}>
      <span className="flex gap-1 items-center" aria-label="Typing">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-[6px] h-[6px] rounded-full bg-[var(--fg-muted)] animate-[typingBounce_1.2s_infinite]"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </span>
      {agentName && <span className="text-[11px] text-[var(--fg-muted)] italic">{agentName} is typing</span>}
    </div>
  );
}

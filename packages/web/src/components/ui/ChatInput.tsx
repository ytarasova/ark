import { useRef, useCallback } from "react";
import { cn } from "../../lib/utils.js";

export interface ChatInputProps extends React.ComponentProps<"div"> {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled?: boolean;
  disabledText?: string;
  modelName?: string;
  placeholder?: string;
}

/**
 * Bottom input bar for sending messages to agents.
 * Supports Cmd+K hint, model name display, and send button.
 * Enter to send, Shift+Enter for newline.
 */
export function ChatInput({
  value,
  onChange,
  onSend,
  disabled = false,
  disabledText,
  modelName,
  placeholder = "Send message to agent...",
  className,
  ...props
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !disabled) {
        e.preventDefault();
        onSend();
      }
    },
    [onSend, disabled],
  );

  return (
    <div
      className={cn("border-t border-[var(--border)] px-6 py-3.5 pb-4 shrink-0 bg-[var(--bg)]", className)}
      {...props}
    >
      <div className="max-w-[720px] mx-auto flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? (disabledText ?? "Session is not running") : placeholder}
          disabled={disabled}
          rows={1}
          className={cn(
            "flex-1 border border-[var(--border)] rounded-lg px-3 py-[9px]",
            "text-[13px] text-[var(--fg)] bg-[var(--bg-input)] outline-none resize-none",
            "min-h-[38px] max-h-[160px] leading-[1.5]",
            "placeholder:text-[var(--fg-faint)] focus:border-[var(--primary)]",
            "transition-colors duration-150",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        />
        <button
          type="button"
          onClick={onSend}
          disabled={disabled || !value.trim()}
          className={cn(
            "w-[38px] h-[38px] rounded-lg border-none shrink-0",
            "bg-[var(--primary)] text-[var(--primary-fg)] cursor-pointer",
            "flex items-center justify-center",
            "hover:bg-[var(--primary-hover)] transition-colors duration-150",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
          aria-label="Send"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 2L11 13" />
            <path d="M22 2L15 22L11 13L2 9L22 2Z" />
          </svg>
        </button>
      </div>
      <div className="max-w-[720px] mx-auto mt-1 flex justify-between text-[10px] text-[var(--fg-faint)]">
        <span>
          <kbd className="text-[9px] px-1 py-[1px] rounded-[3px] border border-[var(--border)] bg-[var(--bg-card)] text-[var(--fg-muted)]">
            Cmd+K
          </kbd>{" "}
          Command palette
        </span>
        {modelName && <span className="font-[family-name:var(--font-mono-ui)]">{modelName}</span>}
      </div>
    </div>
  );
}

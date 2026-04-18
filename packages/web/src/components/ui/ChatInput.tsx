import { useState, useRef, useCallback } from "react";
import { cn } from "../../lib/utils.js";
import { X } from "lucide-react";

interface PastedImage {
  name: string;
  dataUrl: string;
}

export interface ChatInputProps extends React.ComponentProps<"div"> {
  value: string;
  onChange: (value: string) => void;
  onSend: (attachments?: PastedImage[]) => void;
  disabled?: boolean;
  disabledText?: string;
  modelName?: string;
  placeholder?: string;
}

/**
 * Bottom input bar for sending messages to agents.
 * Supports Cmd+K hint, model name display, send button, and Cmd+V image paste.
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
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey && !disabled) {
        e.preventDefault();
        onSend(pastedImages.length > 0 ? pastedImages : undefined);
        setPastedImages([]);
      }
    },
    [onSend, disabled, pastedImages],
  );

  const handleSendClick = useCallback(() => {
    onSend(pastedImages.length > 0 ? pastedImages : undefined);
    setPastedImages([]);
  }, [onSend, pastedImages]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (!item.type.startsWith("image/")) continue;
      e.preventDefault();
      const blob = item.getAsFile();
      if (!blob) continue;
      const ext = item.type.split("/")[1] || "png";
      const name = `clipboard-${Date.now()}.${ext}`;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setPastedImages((prev) => [...prev, { name, dataUrl }]);
      };
      reader.readAsDataURL(blob);
      break; // only handle first image
    }
  }, []);

  const removeImage = useCallback((name: string) => {
    setPastedImages((prev) => prev.filter((img) => img.name !== name));
  }, []);

  return (
    <div
      className={cn("border-t border-[var(--border)] px-6 py-3.5 pb-4 shrink-0 bg-[var(--bg)]", className)}
      {...props}
    >
      {/* Pasted image previews */}
      {pastedImages.length > 0 && (
        <div className="max-w-[720px] mx-auto mb-2 flex flex-wrap gap-2">
          {pastedImages.map((img) => (
            <div
              key={img.name}
              className={cn(
                "relative group w-16 h-16 rounded-md overflow-hidden",
                "border border-[var(--border)] bg-[var(--bg-card)]",
              )}
            >
              <img src={img.dataUrl} alt={img.name} className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => removeImage(img.name)}
                className={cn(
                  "absolute top-0.5 right-0.5 w-4 h-4 rounded-full",
                  "bg-black/60 text-white flex items-center justify-center",
                  "opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer",
                )}
              >
                <X size={10} />
              </button>
              <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-[8px] text-white px-1 truncate">
                {img.name}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="max-w-[720px] mx-auto flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
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
          onClick={handleSendClick}
          disabled={disabled || (!value.trim() && pastedImages.length === 0)}
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

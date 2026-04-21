import { useCallback } from "react";
import { Bold, Italic, Code, List, Paperclip, Link, X } from "lucide-react";
import { cn } from "../../../lib/utils.js";
import { usePasteImageUpload } from "../../../hooks/usePasteImageUpload.js";
import { type InputsValue } from "../InputsSection.js";
import type { AttachmentInfo, DetectedReference } from "./types.js";

interface RichTaskInputProps {
  value: string;
  onChange: (val: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  attachments: AttachmentInfo[];
  onAttachmentsChange: (a: AttachmentInfo[] | ((prev: AttachmentInfo[]) => AttachmentInfo[])) => void;
  references: DetectedReference[];
  inputs: InputsValue;
  onInputsChange: (next: InputsValue) => void;
  previews: Record<string, string>;
  onPreview: (role: string, blob: Blob) => void;
  onClearPreview: (role: string) => void;
}

/**
 * Markdown-aware textarea for the task description. Adds a formatting
 * toolbar (bold / italic / code / list / link), a chip row for inserting
 * `{{files.X}}` / `{{params.X}}` tokens into the text, an attachment chip
 * row and an inline reference chip row.
 *
 * Pasted images are consumed by `usePasteImageUpload` and inserted as
 * `{{files.<role>}}` tokens.
 */
export function RichTaskInput({
  value,
  onChange,
  textareaRef,
  attachments,
  onAttachmentsChange,
  references,
  inputs,
  onInputsChange,
  previews,
  onPreview,
  onClearPreview,
}: RichTaskInputProps) {
  const wrapSelection = useCallback(
    (prefix: string, suffix: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const selected = value.slice(start, end);
      const before = value.slice(0, start);
      const after = value.slice(end);
      const wrapped = `${before}${prefix}${selected || "text"}${suffix}${after}`;
      onChange(wrapped);
      requestAnimationFrame(() => {
        ta.focus();
        const newStart = start + prefix.length;
        const newEnd = selected ? newStart + selected.length : newStart + 4; // "text" length
        ta.setSelectionRange(newStart, newEnd);
      });
    },
    [value, onChange, textareaRef],
  );

  const insertPrefix = useCallback(
    (prefix: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const before = value.slice(0, start);
      const after = value.slice(start);
      const needsNewline = before.length > 0 && before[before.length - 1] !== "\n";
      const inserted = `${before}${needsNewline ? "\n" : ""}${prefix}`;
      onChange(`${inserted}${after}`);
      requestAnimationFrame(() => {
        ta.focus();
        const pos = inserted.length;
        ta.setSelectionRange(pos, pos);
      });
    },
    [value, onChange, textareaRef],
  );

  /** Insert a literal string at the cursor (or replace selection). */
  const insertAtCursor = useCallback(
    (text: string) => {
      const ta = textareaRef.current;
      if (!ta) {
        onChange(value + text);
        return;
      }
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = value.slice(0, start) + text + value.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        ta.focus();
        const pos = start + text.length;
        ta.setSelectionRange(pos, pos);
      });
    },
    [value, onChange, textareaRef],
  );

  const fileTokens = Object.entries(inputs.files ?? {}).filter(([, v]) => v);
  const paramTokens = Object.entries(inputs.params ?? {}).filter(([, v]) => v !== undefined && v !== "");

  /** Strip every occurrence of `token` from the task text (literal match). */
  function stripToken(token: string) {
    if (value.includes(token)) onChange(value.split(token).join(""));
  }

  function removeFileToken(role: string) {
    const { [role]: _omit, ...rest } = inputs.files;
    onInputsChange({ ...inputs, files: rest });
    onClearPreview(role);
    stripToken(`{{files.${role}}}`);
  }

  function removeParamToken(key: string) {
    const { [key]: _omit, ...rest } = inputs.params;
    onInputsChange({ ...inputs, params: rest });
    stripToken(`{{params.${key}}}`);
  }

  const removeAttachment = useCallback(
    (name: string) => {
      onAttachmentsChange(attachments.filter((a) => a.name !== name));
    },
    [attachments, onAttachmentsChange],
  );

  const { onPaste: handlePaste } = usePasteImageUpload({
    inputs,
    onInputsChange,
    onUploaded: (role) => insertAtCursor(`{{files.${role}}}`),
    onPreview,
    onError: (msg) => alert(msg),
  });

  const toolbarBtnClass = cn(
    "p-1 rounded hover:bg-[var(--bg-hover)] text-[var(--fg-muted)]",
    "hover:text-[var(--fg)] transition-colors duration-100 cursor-pointer",
  );

  return (
    <div>
      <div
        className={cn(
          "rounded-xl border border-[var(--border)] bg-[var(--bg-hover,var(--bg))]",
          "focus-within:border-[var(--primary)] focus-within:ring-1 focus-within:ring-[var(--primary)]/20",
          "transition-colors duration-150",
        )}
      >
        {/* Toolbar */}
        <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-[var(--border)]">
          <button
            type="button"
            className={toolbarBtnClass}
            title="Bold (Ctrl+B)"
            onClick={() => wrapSelection("**", "**")}
          >
            <Bold size={14} />
          </button>
          <button
            type="button"
            className={toolbarBtnClass}
            title="Italic (Ctrl+I)"
            onClick={() => wrapSelection("_", "_")}
          >
            <Italic size={14} />
          </button>
          <button type="button" className={toolbarBtnClass} title="Code" onClick={() => wrapSelection("`", "`")}>
            <Code size={14} />
          </button>
          <button type="button" className={toolbarBtnClass} title="List item" onClick={() => insertPrefix("- ")}>
            <List size={14} />
          </button>
          <div className="w-px h-4 bg-[var(--border)] mx-1" />
          <button
            type="button"
            className={toolbarBtnClass}
            title="Insert link"
            onClick={() => wrapSelection("[", "](url)")}
          >
            <Link size={14} />
          </button>
        </div>

        {/* Reusable input tokens -- click to insert `{{files.X}}` / `{{params.X}}` at cursor. */}
        {(fileTokens.length > 0 || paramTokens.length > 0) && (
          <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 border-b border-[var(--border)] text-[11px]">
            <span className="text-[var(--fg-muted)] uppercase tracking-[0.04em] mr-1">Insert</span>
            {fileTokens.map(([role]) => (
              <span
                key={`file-${role}`}
                className={cn(
                  "group inline-flex items-center gap-1 rounded-md",
                  "bg-[var(--primary)]/10 text-[var(--fg)] border border-[var(--border)]",
                )}
              >
                <button
                  type="button"
                  onClick={() => insertAtCursor(`{{files.${role}}}`)}
                  title={`Insert {{files.${role}}}`}
                  className="inline-flex items-center gap-1 pl-1 pr-1 py-0.5 hover:bg-[var(--primary)]/20 rounded-l-md transition-colors"
                >
                  {previews[role] ? (
                    <img src={previews[role]} alt="" className="h-4 w-4 rounded object-cover" />
                  ) : (
                    <Paperclip size={10} className="text-[var(--fg-muted)]" />
                  )}
                  {role}
                </button>
                <button
                  type="button"
                  onClick={() => removeFileToken(role)}
                  title={`Remove {{files.${role}}}`}
                  aria-label={`Remove ${role}`}
                  className="pr-1.5 py-0.5 text-[var(--fg-muted)] hover:text-[var(--failed)] transition-colors"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            {paramTokens.map(([key]) => (
              <span
                key={`param-${key}`}
                className={cn(
                  "group inline-flex items-center gap-1 rounded-md",
                  "bg-[var(--primary)]/10 text-[var(--fg)] border border-[var(--border)]",
                )}
              >
                <button
                  type="button"
                  onClick={() => insertAtCursor(`{{params.${key}}}`)}
                  title={`Insert {{params.${key}}}`}
                  className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 hover:bg-[var(--primary)]/20 rounded-l-md transition-colors"
                >
                  <span className="text-[var(--fg-muted)]">$</span>
                  {key}
                </button>
                <button
                  type="button"
                  onClick={() => removeParamToken(key)}
                  title={`Remove {{params.${key}}}`}
                  aria-label={`Remove ${key}`}
                  className="pr-1.5 py-0.5 text-[var(--fg-muted)] hover:text-[var(--failed)] transition-colors"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          autoFocus
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            const el = e.target;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 400) + "px";
          }}
          onPaste={handlePaste}
          placeholder="What should the agent work on?"
          rows={8}
          className={cn(
            "w-full bg-transparent text-[var(--fg)]",
            "text-[14px] leading-relaxed px-4 py-3 resize-none",
            "focus:outline-none focus-visible:outline-none",
            "placeholder:text-[var(--fg-muted)]",
          )}
        />
      </div>

      {/* Attachment chips */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {attachments.map((a) => (
            <span
              key={a.name}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px]",
                "bg-[var(--primary)]/10 text-[var(--fg)] border border-[var(--border)]",
              )}
            >
              <Paperclip size={10} className="text-[var(--fg-muted)]" />
              {a.name}
              <button
                type="button"
                onClick={() => removeAttachment(a.name)}
                className="ml-0.5 text-[var(--fg-muted)] hover:text-[var(--fg)] cursor-pointer"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Detected references */}
      {references.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {references.map((r) => (
            <span
              key={`${r.type}:${r.value}`}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px]",
                r.type === "jira" && "bg-blue-500/10 text-blue-400 border border-blue-500/20",
                r.type === "github" && "bg-purple-500/10 text-purple-400 border border-purple-500/20",
                r.type === "url" && "bg-[var(--fg-muted)]/10 text-[var(--fg-muted)] border border-[var(--border)]",
              )}
            >
              <Link size={10} />
              {r.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

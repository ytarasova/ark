import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { api } from "../hooks/useApi.js";
import { useHostedMode } from "../hooks/useServerConfig.js";
import { usePasteImageUpload } from "../hooks/usePasteImageUpload.js";
import { useFilePreviews } from "../hooks/useFilePreviews.js";
import { Button } from "./ui/button.js";
import { FolderPickerModal } from "./FolderPickerModal.js";
import { InputsSection, type InputsValue } from "./session/InputsSection.js";
import { cn } from "../lib/utils.js";
import { relTime, formatRepoName } from "../util.js";
import {
  Zap,
  Monitor,
  FolderOpen,
  Check,
  ChevronDown,
  Search,
  Folder,
  Bold,
  Italic,
  Code,
  List,
  Paperclip,
  Link,
  X,
} from "lucide-react";

interface FlowInfo {
  name: string;
  description?: string;
  stages?: string[];
}

interface ComputeInfo {
  name: string;
  type?: string;
  provider?: string;
}

interface RecentRepo {
  path: string;
  basename: string;
  lastUsed: string;
}

interface DetectedReference {
  type: "jira" | "github" | "url";
  value: string;
  label: string;
}

interface AttachmentInfo {
  name: string;
  size: number;
  type: string;
  content?: string;
}

interface NewSessionModalProps {
  onClose: () => void;
  onSubmit: (form: {
    summary: string;
    repo: string;
    flow: string;
    group_name: string;
    ticket: string;
    compute_name: string;
    agent: string;
    dispatch: boolean;
    attachments: AttachmentInfo[];
    references: DetectedReference[];
    inputs?: InputsValue;
  }) => void;
}

// ---------------------------------------------------------------------------
// Shared dropdown trigger style
// ---------------------------------------------------------------------------
const triggerClass = cn(
  "flex items-center justify-between w-full h-9 px-3 rounded-md",
  "border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] text-[13px]",
  "hover:border-[var(--fg-muted)] transition-colors duration-150 cursor-pointer",
  "outline-none focus:ring-2 focus:ring-[var(--primary)]",
);

const popoverContentClass = cn(
  "w-[var(--radix-popover-trigger-width)] max-h-[300px] overflow-y-auto",
  "rounded-md border border-[var(--border)] bg-[var(--bg-card,var(--bg))] shadow-lg",
  "p-1 z-50",
);

// ---------------------------------------------------------------------------
// Flow Dropdown
// ---------------------------------------------------------------------------
function FlowDropdown({
  flows,
  selected,
  onSelect,
}: {
  flows: FlowInfo[];
  selected: string;
  onSelect: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = flows.find((f) => f.name === selected);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={triggerClass}>
          <span className="truncate text-left flex-1">
            {current ? (
              <>
                <span className="font-medium">{current.name}</span>
                {current.description && (
                  <span className="text-[var(--fg-muted)] ml-1.5 text-[12px]">-- {current.description}</span>
                )}
              </>
            ) : (
              <span className="text-[var(--fg-muted)]">Select a flow...</span>
            )}
          </span>
          <ChevronDown size={14} className="text-[var(--fg-muted)] shrink-0 ml-2" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={4} align="start" className={popoverContentClass}>
          {flows.map((f) => (
            <button
              key={f.name}
              type="button"
              onClick={() => {
                onSelect(f.name);
                setOpen(false);
              }}
              className={cn(
                "flex items-start gap-2 w-full text-left px-2.5 py-2 rounded-[var(--radius-sm,4px)]",
                "hover:bg-[var(--bg-hover)] transition-colors duration-100 cursor-pointer",
                selected === f.name && "bg-[var(--primary)]/5",
              )}
            >
              <div className="w-4 pt-0.5 shrink-0">
                {selected === f.name && <Check size={14} className="text-[var(--primary)]" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-medium text-[var(--fg)]">{f.name}</div>
                {f.description && (
                  <div className="text-[12px] text-[var(--fg-muted)] mt-0.5 line-clamp-2">{f.description}</div>
                )}
                {f.stages && f.stages.length > 0 && (
                  <div className="text-[10px] text-[var(--fg-muted)] mt-1 font-mono">
                    {f.stages.length} stages: {f.stages.join(" > ")}
                  </div>
                )}
              </div>
            </button>
          ))}
          {flows.length === 0 && (
            <div className="px-3 py-4 text-[12px] text-[var(--fg-muted)] text-center">No flows available</div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------------------
// Repo Dropdown
// ---------------------------------------------------------------------------
/** Accept either `git@host:owner/repo(.git)?` or `https?://host/owner/repo(.git)?`. */
const GIT_URL_RE = /^(git@[^:\s]+:[^\s]+|https?:\/\/[^\s]+)$/i;

function RepoDropdown({
  value,
  onChange,
  recentRepos,
  onBrowse,
}: {
  value: string;
  onChange: (v: string) => void;
  recentRepos: RecentRepo[];
  onBrowse: () => void;
}) {
  const hosted = useHostedMode();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function tryCommit(raw: string) {
    const v = raw.trim();
    if (!v) return;
    if (hosted && !GIT_URL_RE.test(v)) {
      setError("Remote mode requires a git URL (git@... or https://...)");
      return;
    }
    setError(null);
    onChange(v);
    setOpen(false);
    setSearch("");
  }

  const visibleRecent = hosted ? recentRepos.filter((r) => GIT_URL_RE.test(r.path)) : recentRepos;

  const filtered = search
    ? visibleRecent.filter(
        (r) =>
          r.path.toLowerCase().includes(search.toLowerCase()) ||
          r.basename.toLowerCase().includes(search.toLowerCase()),
      )
    : visibleRecent;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setTimeout(() => inputRef.current?.focus(), 50);
      }}
    >
      <Popover.Trigger asChild>
        <button type="button" className={triggerClass}>
          <FolderOpen size={14} className="text-[var(--fg-muted)] shrink-0 mr-2" />
          <span className="truncate text-left flex-1">
            {value && value !== "." ? (
              <>
                <span className="font-medium">{formatRepoName(value)}</span>
                <span className="text-[var(--fg-muted)] ml-1.5 text-[12px]">{value}</span>
              </>
            ) : (
              <span className="text-[var(--fg-muted)]">Select repository...</span>
            )}
          </span>
          <ChevronDown size={14} className="text-[var(--fg-muted)] shrink-0 ml-2" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={4} align="start" className={popoverContentClass}>
          {/* Search / manual input */}
          <div className="px-2 py-1.5 border-b border-[var(--border)]">
            <div className="flex items-center gap-1.5">
              <Search size={12} className="text-[var(--fg-muted)] shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && search.trim()) tryCommit(search);
                }}
                placeholder={hosted ? "git@github.com:owner/repo or https://..." : "Type path or search..."}
                aria-label="Repository path"
                className="w-full bg-transparent text-[12px] text-[var(--fg)] outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] rounded-[4px] placeholder:text-[var(--fg-faint)]"
              />
            </div>
          </div>

          {/* Recent repos */}
          {filtered.length > 0 && (
            <>
              <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold text-[var(--fg-muted)] uppercase tracking-wider">
                Recent repositories
              </div>
              {filtered.map((r) => (
                <button
                  key={r.path}
                  type="button"
                  onClick={() => {
                    onChange(r.path);
                    setOpen(false);
                    setSearch("");
                  }}
                  className={cn(
                    "flex items-center gap-2 w-full text-left px-2.5 py-1.5 rounded-[var(--radius-sm,4px)]",
                    "hover:bg-[var(--bg-hover)] transition-colors duration-100 cursor-pointer",
                    value === r.path && "bg-[var(--primary)]/5",
                  )}
                >
                  <Folder size={13} className="text-[var(--fg-muted)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-[var(--fg)] truncate">{r.basename}</div>
                    <div className="text-[11px] text-[var(--fg-muted)] truncate">{r.path}</div>
                  </div>
                  <span className="text-[10px] text-[var(--fg-muted)] shrink-0 ml-1">{r.lastUsed}</span>
                </button>
              ))}
            </>
          )}

          {filtered.length === 0 && search && (
            <div className="px-3 py-3 text-[12px] text-[var(--fg-muted)] text-center">
              No matches. Press Enter to use "{search}"
            </div>
          )}

          {error && <div className="px-3 py-2 text-[11px] text-[var(--failed)]">{error}</div>}

          {/* Browse -- local mode only; remote Ark servers have no client filesystem access. */}
          {!hosted && (
            <div className="border-t border-[var(--border)] mt-1 pt-1">
              <button
                type="button"
                onClick={() => {
                  onBrowse();
                  setOpen(false);
                  setSearch("");
                }}
                className={cn(
                  "flex items-center gap-2 w-full text-left px-2.5 py-2 rounded-[var(--radius-sm,4px)]",
                  "hover:bg-[var(--bg-hover)] transition-colors duration-100 cursor-pointer",
                  "text-[12px] text-[var(--fg-muted)]",
                )}
              >
                <FolderOpen size={13} />
                Browse for folder...
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------------------
// Compute Dropdown
// ---------------------------------------------------------------------------
function ComputeDropdown({
  computes,
  selected,
  onSelect,
}: {
  computes: ComputeInfo[];
  selected: string;
  onSelect: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = computes.find((c) => c.name === selected);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={triggerClass}>
          <Monitor size={14} className="text-[var(--fg-muted)] shrink-0 mr-2" />
          <span className="truncate text-left flex-1">
            {current ? (
              <>
                <span className="font-medium">{current.name}</span>
                {current.provider && (
                  <span className="text-[var(--fg-muted)] ml-1.5 text-[12px]">{current.provider}</span>
                )}
              </>
            ) : (
              <span className="text-[var(--fg-muted)]">Select compute...</span>
            )}
          </span>
          <ChevronDown size={14} className="text-[var(--fg-muted)] shrink-0 ml-2" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={4} align="start" className={popoverContentClass}>
          {computes.map((c) => (
            <button
              key={c.name}
              type="button"
              onClick={() => {
                onSelect(c.name);
                setOpen(false);
              }}
              className={cn(
                "flex items-center gap-2 w-full text-left px-2.5 py-2 rounded-[var(--radius-sm,4px)]",
                "hover:bg-[var(--bg-hover)] transition-colors duration-100 cursor-pointer",
                selected === c.name && "bg-[var(--primary)]/5",
              )}
            >
              <div className="w-4 shrink-0">
                {selected === c.name && <Check size={14} className="text-[var(--primary)]" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium text-[var(--fg)]">{c.name}</div>
                {(c.provider || c.type) && (
                  <div className="text-[11px] text-[var(--fg-muted)]">{c.provider || c.type}</div>
                )}
              </div>
            </button>
          ))}
          {computes.length === 0 && (
            <div className="px-3 py-4 text-[12px] text-[var(--fg-muted)] text-center">No compute targets</div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---------------------------------------------------------------------------
// Reference detection
// ---------------------------------------------------------------------------
const JIRA_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const GITHUB_ISSUE_RE = /(?:https?:\/\/github\.com\/([^\s/]+\/[^\s/]+)\/issues\/(\d+))|(?:#(\d+))/g;
const URL_RE = /https?:\/\/[^\s,)]+/g;

function detectReferences(text: string): DetectedReference[] {
  const refs: DetectedReference[] = [];
  const seen = new Set<string>();

  // Jira references
  for (const m of text.matchAll(JIRA_RE)) {
    const key = `jira:${m[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ type: "jira", value: m[1], label: `${m[1]} (Jira)` });
    }
  }

  // GitHub issue references
  for (const m of text.matchAll(GITHUB_ISSUE_RE)) {
    if (m[1] && m[2]) {
      const key = `github:${m[1]}#${m[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ type: "github", value: `${m[1]}/issues/${m[2]}`, label: `${m[1]}#${m[2]} (GitHub)` });
      }
    } else if (m[3]) {
      const key = `github:#${m[3]}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ type: "github", value: `#${m[3]}`, label: `#${m[3]} (GitHub)` });
      }
    }
  }

  // Generic URLs (skip already-captured GitHub URLs)
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0];
    if (url.includes("github.com") && url.includes("/issues/")) continue;
    const key = `url:${url}`;
    if (!seen.has(key)) {
      seen.add(key);
      const short = url.replace(/^https?:\/\//, "").slice(0, 50);
      refs.push({ type: "url", value: url, label: short });
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Markdown toolbar + rich textarea
// ---------------------------------------------------------------------------

function RichTaskInput({
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
}: {
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
}) {
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
      // Restore focus and selection after React render
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
      // If we are at the start of a line, just insert prefix; otherwise add newline first
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
      {/* Container with toolbar + textarea */}
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

// ---------------------------------------------------------------------------
// Zod schema for the NewSession form. Attachments, references and flow
// inputs are managed as separate state because they have non-trivial
// client-only semantics (file reads, regex detection, flow-driven shapes).
// ---------------------------------------------------------------------------
export const NewSessionSchema = z.object({
  summary: z.string().trim().min(1, "Describe the task"),
  repo: z.string().min(1),
  ticket: z.string().default(""),
  flow: z.string().default(""),
  compute: z.string().default(""),
});
export type NewSessionFormValues = z.infer<typeof NewSessionSchema>;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function NewSessionModal({ onClose, onSubmit }: NewSessionModalProps) {
  const { control, handleSubmit, watch, setValue, formState } = useForm<NewSessionFormValues>({
    resolver: zodResolver(NewSessionSchema),
    defaultValues: { summary: "", repo: ".", ticket: "", flow: "", compute: "" },
  });
  const summary = watch("summary");
  const repo = watch("repo");
  const selectedFlow = watch("flow");
  const selectedCompute = watch("compute");

  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [inputs, setInputs] = useState<InputsValue>({ files: {}, params: {} });
  const [inputsValid, setInputsValid] = useState(true);
  const { previews, setPreview, clearPreview } = useFilePreviews();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Save trigger so we can restore focus on close.
  // See `.workflow/audit/8-a11y.md` finding A4.
  // Capture BEFORE the component's autoFocus textarea steals focus -- lazy
  // useState init runs during first render (pre-commit), whereas useEffect
  // runs after commit (post-autoFocus), by which time activeElement is the
  // textarea, not the trigger button.
  const [triggerElement] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null,
  );
  useEffect(() => {
    return () => {
      try {
        triggerElement?.focus?.();
      } catch {
        /* ignore */
      }
    };
  }, [triggerElement]);

  const references = detectReferences(summary);

  const flowsQuery = useQuery<FlowInfo[]>({ queryKey: ["flows"], queryFn: api.getFlows });
  const computesQuery = useQuery<ComputeInfo[]>({ queryKey: ["compute"], queryFn: api.getCompute });
  const recentReposQuery = useQuery<RecentRepo[]>({
    queryKey: ["sessions", "recent-repos"],
    queryFn: async () => {
      const sessions: any[] = await api.getSessions();
      const seen = new Map<string, string>();
      for (const s of sessions) {
        if (s.repo && s.repo !== "." && !seen.has(s.repo)) {
          seen.set(s.repo, s.updated_at || s.created_at || "");
        }
      }
      const repos: RecentRepo[] = [];
      for (const [path, lastUsed] of seen) {
        repos.push({ path, basename: formatRepoName(path), lastUsed: relTime(lastUsed) });
      }
      return repos.slice(0, 15);
    },
  });
  // Memoized defaults so dependent effects don't see a fresh [] each render.
  const flows = useMemo<FlowInfo[]>(() => flowsQuery.data ?? [], [flowsQuery.data]);
  const computes = useMemo<ComputeInfo[]>(() => computesQuery.data ?? [], [computesQuery.data]);
  const recentRepos = useMemo<RecentRepo[]>(() => recentReposQuery.data ?? [], [recentReposQuery.data]);

  const [pickerOpen, setPickerOpen] = useState(false);

  // Auto-select the first flow / compute once the lists load, unless the
  // user has already chosen one. RHF's setValue makes this a one-liner.
  useEffect(() => {
    if (!selectedFlow && flows.length > 0) setValue("flow", flows[0].name);
  }, [flows, selectedFlow, setValue]);
  useEffect(() => {
    if (!selectedCompute && computes.length > 0) setValue("compute", computes[0].name);
  }, [computes, selectedCompute, setValue]);

  // Check if the selected flow looks like it uses tickets
  const currentFlow = flows.find((f) => f.name === selectedFlow);
  const showTicket =
    !!currentFlow &&
    ((currentFlow.description || "").toLowerCase().includes("ticket") ||
      (currentFlow.stages || []).some((s) => s.toLowerCase().includes("ticket")));

  // Keyboard shortcuts: Cmd+Enter to submit, Escape to cancel, Tab/Shift+Tab focus trap.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && summary.trim()) {
        e.preventDefault();
        submit();
        return;
      }
      // Focus trap: keep Tab cycling inside the panel while it's open.
      // The panel renders inline (not as a true modal overlay), so without
      // this trap Tab escapes to the surrounding page chrome (sidebar nav,
      // header actions, etc.) and violates the a11y invariant that the
      // active configuration surface "owns" keyboard focus.
      // See `.workflow/audit/8-a11y.md` finding A3.
      //
      // Edge case: Radix Popover content is rendered through a portal
      // (outside panelRef). When a popover is open we leave focus alone so
      // the user can navigate its items -- Radix manages that focus scope
      // itself and returns focus to the trigger on close.
      if (e.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;
        const active = document.activeElement as HTMLElement | null;
        const inPortal = !!active?.closest("[data-radix-popper-content-wrapper], [role=dialog]");
        if (inPortal) return;
        const focusables = Array.from(
          panel.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => {
          if (el.hasAttribute("disabled")) return false;
          if (el.getAttribute("aria-hidden") === "true") return false;
          // Exclude hidden inputs (file inputs rendered with class="hidden").
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          return true;
        });
        if (focusables.length === 0) {
          e.preventDefault();
          panel.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const activeInside = active && panel.contains(active);
        if (!activeInside) {
          e.preventDefault();
          first.focus();
          return;
        }
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // submit is the handle_submit callback below; summary is included so the
    // Cmd+Enter guard uses the latest value. The RHF-bound values we pass to
    // onSubmit are read from the closure at submit time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, onClose]);

  const submit = handleSubmit((values) => {
    onSubmit({
      summary: values.summary,
      repo: values.repo,
      flow: values.flow,
      ticket: values.ticket,
      compute_name: values.compute,
      agent: "",
      group_name: "",
      dispatch: true,
      attachments,
      references,
      ...(Object.keys(inputs.files).length || Object.keys(inputs.params).length
        ? { inputs: { files: { ...inputs.files }, params: { ...inputs.params } } }
        : {}),
    });
  });

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      className="flex flex-col h-full overflow-y-auto"
      role="region"
      aria-labelledby="new-session-title"
      data-testid="new-session-modal"
    >
      <div className="p-5 pb-0">
        <h2 id="new-session-title" className="text-base font-semibold text-[var(--fg)] mb-1">
          New Session
        </h2>
        <p className="text-[12px] text-[var(--fg-muted)] mb-5">Configure and launch an agent session</p>
      </div>

      <form onSubmit={submit} className="flex flex-col flex-1 min-h-0 px-5" noValidate>
        {/* Flow */}
        <div className="mb-4">
          <label className="block text-[11px] font-semibold text-[var(--fg-muted)] mb-1.5 uppercase tracking-[0.04em]">
            <Zap size={12} className="inline mr-1 opacity-60" />
            Flow
          </label>
          <Controller
            name="flow"
            control={control}
            render={({ field }) => <FlowDropdown flows={flows} selected={field.value} onSelect={field.onChange} />}
          />
        </div>

        {/* Repository */}
        <div className="mb-4">
          <label className="block text-[11px] font-semibold text-[var(--fg-muted)] mb-1.5 uppercase tracking-[0.04em]">
            Repository
          </label>
          <Controller
            name="repo"
            control={control}
            render={({ field }) => (
              <RepoDropdown
                value={field.value}
                onChange={field.onChange}
                recentRepos={recentRepos}
                onBrowse={() => setPickerOpen(true)}
              />
            )}
          />
        </div>

        {/* Compute */}
        <div className="mb-4">
          <label className="block text-[11px] font-semibold text-[var(--fg-muted)] mb-1.5 uppercase tracking-[0.04em]">
            Compute
          </label>
          <Controller
            name="compute"
            control={control}
            render={({ field }) => (
              <ComputeDropdown computes={computes} selected={field.value} onSelect={field.onChange} />
            )}
          />
        </div>

        {/* Flow inputs (files + params) -- driven by the selected flow's
            declarative `inputs:` schema plus any ad-hoc extras the user adds. */}
        <InputsSection
          flowName={selectedFlow}
          value={inputs}
          onChange={setInputs}
          onValidityChange={setInputsValid}
          previews={previews}
          onPreview={setPreview}
          onClearPreview={clearPreview}
        />

        {/* Ticket -- conditional */}
        {showTicket && (
          <div className="mb-4">
            <label className="block text-[11px] text-[var(--fg-muted)] mb-1.5 tracking-[0.04em]">
              Ticket <span className="opacity-50">(optional)</span>
            </label>
            <Controller
              name="ticket"
              control={control}
              render={({ field }) => (
                <input
                  value={field.value}
                  onChange={field.onChange}
                  placeholder="JIRA-123, github.com/org/repo/issues/42"
                  className={cn(
                    "flex h-9 w-full rounded-md border border-[var(--border)] bg-transparent",
                    "px-3 py-1 text-[13px] text-[var(--fg)] transition-colors",
                    "placeholder:text-[var(--fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]",
                  )}
                />
              )}
            />
          </div>
        )}

        {/* Task description -- rich input with markdown toolbar */}
        <div className="mb-4 mt-1">
          <label className="block text-[11px] font-semibold text-[var(--fg-muted)] mb-1.5 uppercase tracking-[0.04em]">
            Task
          </label>
          <Controller
            name="summary"
            control={control}
            render={({ field }) => (
              <RichTaskInput
                value={field.value}
                onChange={field.onChange}
                textareaRef={textareaRef}
                attachments={attachments}
                onAttachmentsChange={setAttachments}
                references={references}
                inputs={inputs}
                onInputsChange={setInputs}
                previews={previews}
                onPreview={setPreview}
                onClearPreview={clearPreview}
              />
            )}
          />
          {formState.errors.summary && (
            <p className="mt-1 text-[11px] text-[var(--failed)]">{formState.errors.summary.message}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-3 pb-5">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel{" "}
            <kbd className="ml-1 text-[9px] opacity-40 font-mono bg-[var(--bg-hover)] px-1 py-0.5 rounded">Esc</kbd>
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!summary.trim() || !inputsValid || formState.isSubmitting}
            title={!inputsValid ? "Fill in all required flow inputs before starting" : undefined}
          >
            Start Session{" "}
            <kbd className="ml-1 text-[9px] opacity-40 font-mono bg-[var(--bg-hover)] px-1 py-0.5 rounded">
              Cmd+Enter
            </kbd>
          </Button>
        </div>
      </form>

      {pickerOpen && (
        <FolderPickerModal
          initialPath={repo && repo !== "." ? repo : undefined}
          onSelect={(path) => {
            setValue("repo", path, { shouldDirty: true });
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

import { useState, useEffect, useRef, useCallback, type FormEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { api } from "../hooks/useApi.js";
import { Button } from "./ui/button.js";
import { FolderPickerModal } from "./FolderPickerModal.js";
import { cn } from "../lib/utils.js";
import { relTime, formatRepoName } from "../util.js";
import { Zap, Monitor, FolderOpen, Check, ChevronDown, Search, Folder, ArrowUp } from "lucide-react";

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
  }) => void;
  /** Whether the daemon conductor is online. When false, session creation is blocked. */
  daemonOnline?: boolean;
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
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = search
    ? recentRepos.filter(
        (r) =>
          r.path.toLowerCase().includes(search.toLowerCase()) ||
          r.basename.toLowerCase().includes(search.toLowerCase()),
      )
    : recentRepos;

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
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && search.trim()) {
                    onChange(search.trim());
                    setOpen(false);
                    setSearch("");
                  }
                }}
                placeholder="Type path or search..."
                className="w-full bg-transparent text-[12px] text-[var(--fg)] outline-none placeholder:text-[var(--fg-faint)]"
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

          {/* Browse */}
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
// Main component
// ---------------------------------------------------------------------------
export function NewSessionModal({ onClose, onSubmit, daemonOnline = true }: NewSessionModalProps) {
  const [summary, setSummary] = useState("");
  const [repo, setRepo] = useState(".");
  const [ticket, setTicket] = useState("");
  const [selectedFlow, setSelectedFlow] = useState("");
  const [selectedCompute, setSelectedCompute] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleTextareaInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setSummary(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  const [flows, setFlows] = useState<FlowInfo[]>([]);
  const [computes, setComputes] = useState<ComputeInfo[]>([]);
  const [recentRepos, setRecentRepos] = useState<RecentRepo[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getFlows()
      .then((f: any[]) => {
        if (cancelled) return;
        setFlows(f);
        if (f.length > 0 && !selectedFlow) setSelectedFlow(f[0].name);
      })
      .catch(() => {});
    api
      .getCompute()
      .then((c: any[]) => {
        if (cancelled) return;
        setComputes(c);
        if (c.length > 0 && !selectedCompute) setSelectedCompute(c[0].name);
      })
      .catch(() => {});
    // Fetch recent repos from past sessions
    api
      .getSessions()
      .then((sessions: any[]) => {
        if (cancelled) return;
        const seen = new Map<string, string>();
        for (const s of sessions) {
          if (s.repo && s.repo !== "." && !seen.has(s.repo)) {
            seen.set(s.repo, s.updated_at || s.created_at || "");
          }
        }
        const repos: RecentRepo[] = [];
        for (const [path, lastUsed] of seen) {
          repos.push({
            path,
            basename: formatRepoName(path),
            lastUsed: relTime(lastUsed),
          });
        }
        setRecentRepos(repos.slice(0, 15));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Check if the selected flow looks like it uses tickets
  const currentFlow = flows.find((f) => f.name === selectedFlow);
  const showTicket =
    currentFlow &&
    ((currentFlow.description || "").toLowerCase().includes("ticket") ||
      (currentFlow.stages || []).some((s) => s.toLowerCase().includes("ticket")));

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!summary.trim()) return;
    onSubmit({
      summary,
      repo,
      flow: selectedFlow,
      ticket,
      compute_name: selectedCompute,
      agent: "",
      group_name: "",
      dispatch: true,
    });
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-5 pb-0">
        <h2 className="text-base font-semibold text-[var(--fg)] mb-1">New Session</h2>
        <p className="text-[12px] text-[var(--fg-muted)] mb-5">Configure and launch an agent session</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0 px-5">
        {/* Flow */}
        <div className="mb-4">
          <label className="block text-[11px] font-semibold text-[var(--fg-muted)] mb-1.5 uppercase tracking-[0.04em]">
            <Zap size={12} className="inline mr-1 opacity-60" />
            Flow
          </label>
          <FlowDropdown flows={flows} selected={selectedFlow} onSelect={setSelectedFlow} />
        </div>

        {/* Repository */}
        <div className="mb-4">
          <label className="block text-[11px] font-semibold text-[var(--fg-muted)] mb-1.5 uppercase tracking-[0.04em]">
            Repository
          </label>
          <RepoDropdown
            value={repo}
            onChange={setRepo}
            recentRepos={recentRepos}
            onBrowse={() => setPickerOpen(true)}
          />
        </div>

        {/* Compute */}
        <div className="mb-4">
          <label className="block text-[11px] font-semibold text-[var(--fg-muted)] mb-1.5 uppercase tracking-[0.04em]">
            Compute
          </label>
          <ComputeDropdown computes={computes} selected={selectedCompute} onSelect={setSelectedCompute} />
        </div>

        {/* Ticket -- conditional */}
        {showTicket && (
          <div className="mb-4">
            <label className="block text-[11px] text-[var(--fg-muted)] mb-1.5 tracking-[0.04em]">
              Ticket <span className="opacity-50">(optional)</span>
            </label>
            <input
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
              placeholder="JIRA-123, github.com/org/repo/issues/42"
              className={cn(
                "flex h-9 w-full rounded-md border border-[var(--border)] bg-transparent",
                "px-3 py-1 text-[13px] text-[var(--fg)] transition-colors",
                "placeholder:text-[var(--fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]",
              )}
            />
          </div>
        )}

        {/* Daemon offline warning */}
        {!daemonOnline && (
          <div className="mb-3 px-3 py-2 rounded-md bg-[var(--failed)]/10 border border-[var(--failed)]/30 text-[12px] text-[var(--failed)]">
            Daemon is offline -- sessions cannot be orchestrated. Start it first:{" "}
            <code className="bg-[var(--failed)]/10 px-1 py-0.5 rounded text-[11px]">ark server daemon start</code>
          </div>
        )}

        {/* Task description -- chat-style input */}
        <div className="mb-4 mt-1">
          <label className="block text-[11px] font-semibold text-[var(--fg-muted)] mb-1.5 uppercase tracking-[0.04em]">
            Task
          </label>
          <div className="relative">
            <textarea
              ref={textareaRef}
              autoFocus
              value={summary}
              onChange={handleTextareaInput}
              placeholder="What should the agent do?"
              rows={3}
              className={cn(
                "w-full rounded-xl border border-[var(--border)] bg-[var(--bg-hover,var(--bg))] text-[var(--fg)]",
                "text-[14px] leading-relaxed px-4 py-3 pr-12 resize-none",
                "focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/20",
                "placeholder:text-[var(--fg-muted)]",
              )}
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-3 pb-5">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!summary.trim() || !daemonOnline}
            title={!daemonOnline ? "Start the daemon first" : undefined}
          >
            Start Session
          </Button>
        </div>
      </form>

      {pickerOpen && (
        <FolderPickerModal
          initialPath={repo && repo !== "." ? repo : undefined}
          onSelect={(path) => {
            setRepo(path);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

import { ChevronRight, ExternalLink, FileText, GitBranch, GitCommit, GitMerge } from "lucide-react";
import { useState } from "react";
import { cn } from "../../lib/utils.js";
import type { StageGroup } from "./timeline-builder.js";

/**
 * Stage group header shown above each cluster of timeline items in the
 * Conversation tab.
 *
 * Renders:
 *   - chevron (collapse / expand)
 *   - status dot with semantic colour (active = blue/pulse, done = green,
 *     failed = red, pending = muted)
 *   - stage name + agent
 *   - duration (when computable)
 *   - artifact chips: files touched count, commits, PR link, merge state
 *
 * Pre-stage / unattached items are grouped into a header named "Setup".
 */
export interface StageGroupHeaderProps {
  group: StageGroup;
  /** Total stages in the flow + this stage's index, when available, so we
   *  can show "Stage 2 of 3 · verify" instead of the bare name. */
  index?: number;
  total?: number;
  /** Children are the stage's timeline items, rendered when expanded. */
  children: React.ReactNode;
  /** Default expanded for the active and failed groups; collapsed for done. */
  defaultExpanded?: boolean;
}

const STATUS_DOT: Record<StageGroup["status"], { fill: string; ring?: string; pulse?: boolean }> = {
  active: { fill: "#60a5fa", ring: "rgba(96,165,250,0.45)", pulse: true },
  done: { fill: "#34d399" },
  failed: { fill: "#f87171", ring: "rgba(248,113,113,0.4)" },
  pending: { fill: "rgba(156,163,175,0.5)" },
};

export function StageGroupHeader({ group, index, total, children, defaultExpanded }: StageGroupHeaderProps) {
  const initialOpen = defaultExpanded ?? (group.status === "active" || group.status === "failed");
  const [open, setOpen] = useState(initialOpen);
  const dot = STATUS_DOT[group.status];
  const label = group.name ?? "Setup";
  const showCounter = index != null && total != null && group.name != null;

  const filesCount = group.artifacts.filesTouched.length;
  const commits = group.artifacts.commits;
  const prUrl = group.artifacts.prUrl;
  const merged = group.artifacts.merged;
  // Pending stages have not run yet -- any "artifacts" or "duration" we
  // accumulated for them comes from stale events that shouldn't be
  // attributed here (#435 repro: events stamped with a future stage
  // before the agent actually got there). Suppress the chips so the
  // header reads honestly: pending = nothing has happened here.
  const isPending = group.status === "pending";
  const hasArtifacts = !isPending && (filesCount > 0 || commits > 0 || !!prUrl || !!merged);
  const showDuration = !isPending && group.duration;

  return (
    <section className="my-[14px] rounded-[8px] border border-[var(--border)] bg-[var(--bg-card)]/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "w-full flex items-center gap-[10px] px-[12px] py-[9px] text-left",
          "bg-[rgba(0,0,0,0.18)] border-0 cursor-pointer",
          "hover:bg-[rgba(0,0,0,0.26)] transition-colors",
          open && "border-b border-[var(--border)]",
        )}
      >
        <ChevronRight
          size={13}
          strokeWidth={2}
          aria-hidden
          className={cn("text-[var(--fg-muted)] shrink-0 transition-transform duration-[120ms]", open && "rotate-90")}
        />

        <span className="relative inline-flex items-center justify-center shrink-0">
          <span
            aria-hidden
            className="w-[8px] h-[8px] rounded-full"
            style={{ background: dot.fill, boxShadow: dot.ring ? `0 0 0 3px ${dot.ring}` : undefined }}
          />
          {dot.pulse && (
            <span
              aria-hidden
              className="absolute inset-[-3px] rounded-full animate-[ping_1600ms_ease-out_infinite]"
              style={{ boxShadow: `0 0 0 2px ${dot.ring}`, opacity: 0.6 }}
            />
          )}
        </span>

        {showCounter && (
          <span className="font-[family-name:var(--font-mono-ui)] text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--fg-faint)] shrink-0">
            stage {index! + 1}/{total}
          </span>
        )}

        <span className="font-[family-name:var(--font-sans)] text-[13px] font-semibold text-[var(--fg)] tracking-[-0.005em] shrink-0">
          {label}
        </span>

        {group.agent && (
          <span className="font-[family-name:var(--font-mono-ui)] text-[10px] font-medium uppercase tracking-[0.05em] text-[var(--fg-muted)] shrink-0">
            {group.agent}
          </span>
        )}

        <span
          className={cn(
            "font-[family-name:var(--font-mono-ui)] text-[10px] font-medium uppercase tracking-[0.05em] shrink-0",
            group.status === "active" && "text-[var(--running)]",
            group.status === "done" && "text-[var(--completed)]",
            group.status === "failed" && "text-[var(--failed)]",
            group.status === "pending" && "text-[var(--fg-muted)]",
          )}
        >
          {group.status === "active" ? "running" : group.status}
        </span>

        <span className="flex-1" />

        {hasArtifacts && (
          <span className="flex items-center gap-[8px] shrink-0">
            {filesCount > 0 && (
              <ArtifactChip
                icon={<FileText size={11} strokeWidth={2} />}
                label={`${filesCount} file${filesCount === 1 ? "" : "s"}`}
              />
            )}
            {commits > 0 && (
              <ArtifactChip
                icon={<GitCommit size={11} strokeWidth={2} />}
                label={`${commits} commit${commits === 1 ? "" : "s"}`}
              />
            )}
            {group.artifacts.branch && (
              <ArtifactChip icon={<GitBranch size={11} strokeWidth={2} />} label={group.artifacts.branch} />
            )}
            {prUrl && (
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-[4px] px-[7px] h-[20px] rounded-[4px] border border-[rgba(107,89,222,0.35)] bg-[rgba(107,89,222,0.12)] text-[#b0a3ff] font-[family-name:var(--font-mono-ui)] text-[10px] font-medium uppercase tracking-[0.04em] no-underline hover:bg-[rgba(107,89,222,0.18)] transition-colors"
              >
                <ExternalLink size={11} strokeWidth={2} />
                pr
              </a>
            )}
            {merged && (
              <ArtifactChip
                icon={<GitMerge size={11} strokeWidth={2} />}
                label={merged.ok ? "merged" : "merge failed"}
                tone={merged.ok ? "ok" : "fail"}
              />
            )}
          </span>
        )}

        {showDuration && (
          <span className="font-[family-name:var(--font-mono)] text-[10px] text-[var(--fg-faint)] shrink-0 tabular-nums">
            {group.duration}
          </span>
        )}
      </button>

      {open && <div className="px-[12px] py-[10px]">{children}</div>}
    </section>
  );
}

function ArtifactChip({
  icon,
  label,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  label: string;
  tone?: "neutral" | "ok" | "fail";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[4px] px-[7px] h-[20px] rounded-[4px] border bg-[rgba(0,0,0,0.18)] font-[family-name:var(--font-mono-ui)] text-[10px] font-medium uppercase tracking-[0.04em]",
        tone === "neutral" && "border-[var(--border)] text-[var(--fg-muted)]",
        tone === "ok" && "border-[rgba(52,211,153,0.3)] bg-[rgba(52,211,153,0.1)] text-[#34d399]",
        tone === "fail" && "border-[rgba(248,113,113,0.3)] bg-[rgba(248,113,113,0.1)] text-[#f87171]",
      )}
    >
      {icon}
      <span className="normal-case tracking-normal">{label}</span>
    </span>
  );
}

import { cn } from "../../lib/utils.js";
import type { StageProgress } from "./StageProgressBar.js";

export interface FlowDagNode {
  name: string;
  state: "done" | "running" | "pending" | "failed" | "stopped" | "active";
  /** Agent label (claude / codex / gemini / goose). */
  agent?: string;
  /** Elapsed or predicted time string -- e.g. `14s`, `1:22`. */
  timing?: string;
  /** Running stage progress, 0..1. */
  progress?: number;
}

export interface FlowDagProps {
  /** Flow display name (header). */
  name?: string;
  /** Session id (header meta). */
  sessionId?: string;
  /** Per-node data (ordered). */
  nodes: FlowDagNode[];
  /** Width of each stage box. Default 150. */
  nodeWidth?: number;
  /** Default vertical position. Default 60. */
  nodeHeight?: number;
  /** Horizontal gap between neighbors. Default 44. */
  gap?: number;
  className?: string;
  compact?: boolean;
}

/**
 * FlowDag -- per /tmp/ark-design-system/preview/flow-dag.html
 *
 * Linear pipeline of stage boxes, animated SVG connectors between them.
 * - done: green node + green solid arrow
 * - running: blue gradient node + dashed animated blue arrow (marching ants)
 *            + 2px shimmer bar at the bottom showing progress
 * - pending: dashed gray node + dashed gray arrow
 *
 * We draw simple horizontal chains; fan-out branches need a richer
 * description (future work). For the common 1D case, that's all we need.
 */
export function FlowDag({
  name,
  sessionId,
  nodes,
  nodeWidth: nwProp,
  nodeHeight: nhProp,
  gap: gapProp,
  className,
  compact,
}: FlowDagProps) {
  const nw = nwProp ?? (compact ? 120 : 150);
  const nh = nhProp ?? (compact ? 48 : 60);
  const gap = gapProp ?? (compact ? 28 : 44);

  const doneCount = nodes.filter((n) => n.state === "done").length;
  const totalCount = nodes.length;

  const width = totalCount * nw + Math.max(0, totalCount - 1) * gap;
  const height = nh + 40; // padding top+bottom for shadows
  const yTop = 20;

  // Node positions
  const positions = nodes.map((_, i) => ({
    x: i * (nw + gap),
    y: yTop,
  }));

  // Edges between consecutive nodes; edge state = downstream node state
  const edges = nodes.slice(1).map((n, i) => {
    const from = positions[i];
    const to = positions[i + 1];
    return {
      x1: from.x + nw,
      y1: from.y + nh / 2,
      x2: to.x - 2,
      y2: to.y + nh / 2,
      state: edgeStateFor(nodes[i].state, n.state),
    };
  });

  return (
    <div
      className={cn(
        "rounded-[10px] border border-[var(--border)] bg-[var(--bg-card)]",
        "shadow-[0_1px_2px_rgba(0,0,0,0.4),0_8px_18px_-6px_rgba(0,0,0,0.4)]",
        "p-[12px_14px_14px]",
        className,
      )}
    >
      {(name || sessionId) && (
        <div className="flex items-center justify-between gap-[10px] mb-[10px]">
          <div className="font-[family-name:var(--font-sans)] text-[12px] font-semibold text-[var(--fg)] whitespace-nowrap">
            {name && <>Flow &middot; {name}</>}
            {sessionId && (
              <span className="font-[family-name:var(--font-mono-ui)] text-[10px] font-normal uppercase tracking-[0.04em] text-[var(--fg-faint)] ml-[6px]">
                {sessionId} &middot; {doneCount}/{totalCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-[10px] font-[family-name:var(--font-mono-ui)] text-[9px] font-medium uppercase tracking-[0.05em] text-[var(--fg-muted)] whitespace-nowrap">
            <LegendDot color="#34d399" label="done" />
            <LegendDot color="#60a5fa" label="running" />
            <LegendDot color="#3a3a54" label="pending" />
          </div>
        </div>
      )}

      <div
        className={cn(
          "relative overflow-auto rounded-[8px] border border-[rgba(0,0,0,0.5)]",
          "shadow-[inset_0_2px_5px_rgba(0,0,0,0.55)]",
        )}
        style={{
          backgroundImage: `radial-gradient(ellipse 70% 60% at 50% 40%, rgba(107,89,222,.05), transparent 70%), linear-gradient(180deg, rgba(0,0,0,.3) 0%, rgba(0,0,0,0) 30%)`,
          backgroundColor: "#0c0c18",
        }}
      >
        <DotsBackdrop />
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          className="block w-full h-auto relative z-[1]"
        >
          <defs>
            <marker
              id="ah-done"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#34d399" opacity="0.85" />
            </marker>
            <marker
              id="ah-run"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path
                d="M 0 0 L 10 5 L 0 10 z"
                fill="#60a5fa"
                style={{ filter: "drop-shadow(0 0 3px rgba(96,165,250,0.8))" }}
              />
            </marker>
            <marker
              id="ah-pend"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#3a3a54" />
            </marker>
          </defs>

          {/* Edges */}
          {edges.map((e, i) => {
            const strokeCls = e.state === "done" ? "done" : e.state === "run" ? "run" : "pend";
            return (
              <g key={i}>
                {strokeCls === "run" && (
                  <line
                    x1={e.x1}
                    y1={e.y1}
                    x2={e.x2}
                    y2={e.y2}
                    stroke="#60a5fa"
                    strokeWidth={6}
                    opacity={0.1}
                    style={{ filter: "blur(3px)" }}
                    fill="none"
                  />
                )}
                <line
                  x1={e.x1}
                  y1={e.y1}
                  x2={e.x2}
                  y2={e.y2}
                  className={cn("edge", strokeCls === "run" && "dag-edge-active")}
                  stroke={strokeCls === "done" ? "#34d399" : strokeCls === "run" ? "#60a5fa" : "#3a3a54"}
                  strokeWidth={1.75}
                  strokeLinecap="round"
                  strokeDasharray={strokeCls === "done" ? undefined : strokeCls === "run" ? "6 6" : "4 4"}
                  opacity={strokeCls === "done" ? 0.75 : 1}
                  fill="none"
                  markerEnd={`url(#ah-${strokeCls})`}
                  style={strokeCls === "run" ? { filter: "drop-shadow(0 0 3px rgba(96,165,250,0.7))" } : undefined}
                />
              </g>
            );
          })}

          {/* Nodes */}
          {nodes.map((n, i) => {
            const p = positions[i];
            return (
              <foreignObject key={i} x={p.x} y={p.y} width={nw} height={nh}>
                <NodeBox node={n} />
              </foreignObject>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function edgeStateFor(from: FlowDagNode["state"], to: FlowDagNode["state"]): "done" | "run" | "pend" {
  if (from === "done" && to === "done") return "done";
  if (to === "active" || to === "running" || from === "running" || from === "active") return "run";
  if (from === "done" && to === "pending") return "done";
  return "pend";
}

function NodeBox({ node }: { node: FlowDagNode }) {
  const { state, name, agent, timing, progress } = node;
  const done = state === "done";
  const running = state === "running" || state === "active";
  const failed = state === "failed";
  const stopped = state === "stopped";
  const pending = state === "pending" || (!done && !running && !failed && !stopped);
  return (
    <div
      xmlns="http://www.w3.org/1999/xhtml"
      className={cn(
        "w-full h-full rounded-[8px] box-border px-[11px] py-[9px]",
        "flex flex-col justify-center gap-[4px] overflow-hidden",
        "font-[family-name:var(--font-sans)]",
        done &&
          "bg-[linear-gradient(180deg,rgba(52,211,153,0.14)_0%,rgba(52,211,153,0.05)_100%)] border border-[rgba(52,211,153,0.38)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_1px_2px_rgba(0,0,0,0.4)]",
        running &&
          "bg-[linear-gradient(180deg,rgba(96,165,250,0.22)_0%,rgba(96,165,250,0.08)_100%)] border border-[rgba(96,165,250,0.55)] shadow-[0_0_0_3px_rgba(96,165,250,0.08),inset_0_1px_0_rgba(255,255,255,0.06),0_1px_2px_rgba(0,0,0,0.4),0_6px_14px_-4px_rgba(96,165,250,0.3)]",
        failed &&
          "bg-[linear-gradient(180deg,rgba(248,113,113,0.2)_0%,rgba(248,113,113,0.05)_100%)] border border-[rgba(248,113,113,0.55)]",
        stopped && "bg-[rgba(255,255,255,0.02)] border border-dashed border-[var(--fg-faint)]",
        pending && "bg-[rgba(255,255,255,0.02)] border border-dashed border-[#33334d]",
      )}
    >
      <div
        className={cn(
          "font-[family-name:var(--font-mono-ui)] text-[9px] font-semibold uppercase tracking-[0.06em]",
          "inline-flex items-center gap-[5px] whitespace-nowrap overflow-hidden",
          done && "text-[#6ee7b7]",
          running && "text-[#93c5fd]",
          failed && "text-[var(--failed)]",
          (stopped || pending) && "text-[var(--fg-muted)]",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "inline-block w-[5px] h-[5px] rounded-full shrink-0",
            done && "bg-[#34d399] shadow-[0_0_5px_rgba(52,211,153,0.6)]",
            running && "bg-[#60a5fa] shadow-[0_0_8px_#60a5fa] animate-[pulse_1.4s_ease-in-out_infinite]",
            failed && "bg-[var(--failed)]",
            (stopped || pending) && "bg-[#3a3a54]",
          )}
        />
        {done ? "done" : running ? "running" : failed ? "failed" : stopped ? "stopped" : "queued"}
        {timing && (
          <>
            <span className="opacity-30">·</span>
            {timing}
          </>
        )}
        {agent && (
          <>
            <span className="opacity-30">·</span>
            {agent}
          </>
        )}
      </div>
      <div
        className={cn(
          "font-semibold text-[13.5px] tracking-[-0.01em] truncate",
          running || done || failed ? "text-[var(--fg)]" : "text-[var(--fg-muted)]",
        )}
      >
        {name}
      </div>
      {running && progress != null && (
        <div className="mt-[4px] h-[2px] rounded-full bg-[rgba(0,0,0,0.5)] overflow-hidden">
          <i
            className="block h-full rounded-full shadow-[0_0_6px_rgba(96,165,250,0.5)]"
            style={{
              width: `${Math.max(0, Math.min(1, progress)) * 100}%`,
              background: "linear-gradient(90deg,#60a5fa,#a78bfa)",
            }}
          />
        </div>
      )}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-[4px]">
      <i aria-hidden className="inline-block w-[6px] h-[6px] rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

function DotsBackdrop() {
  return (
    <span
      aria-hidden
      className="absolute inset-0 pointer-events-none"
      style={{
        backgroundImage: "radial-gradient(rgba(255,255,255,.04) 1px, transparent 1px)",
        backgroundSize: "14px 14px",
        backgroundPosition: "7px 7px",
        maskImage: "radial-gradient(ellipse 90% 80% at 50% 50%, #000 55%, transparent 100%)",
        WebkitMaskImage: "radial-gradient(ellipse 90% 80% at 50% 50%, #000 55%, transparent 100%)",
      }}
    />
  );
}

/* ------------------------------------------------------------------------- */

/** Convert legacy `StageProgress[]` -> FlowDagNode[]. */
export function stagesToFlowDagNodes(stages: StageProgress[]): FlowDagNode[] {
  return stages.map((s: any) => {
    const state: FlowDagNode["state"] =
      s.state === "active"
        ? "running"
        : s.state === "done"
          ? "done"
          : s.state === "failed"
            ? "failed"
            : s.state === "stopped"
              ? "stopped"
              : "pending";
    return { name: s.name, state, timing: s.timing, agent: s.agent, progress: s.progress };
  });
}

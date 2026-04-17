/**
 * Expandable detail panel shown below the pipeline when a stage is clicked.
 *
 * Displays: summary, tool calls, metrics (duration, tokens, cost),
 * and a "View in conversation" link.
 */

import { memo } from "react";
import type { StageDetailData, PipelineStage } from "./types.js";

export interface StageDetailPanelProps {
  stage: PipelineStage;
  detail: StageDetailData | null;
  onViewConversation?: () => void;
  onClose: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  completed: "#34d399",
  running: "var(--primary)",
  failed: "#f87171",
  waiting: "#fbbf24",
  pending: "var(--muted-foreground)",
};

function formatDuration(ms: number | null): string {
  if (ms === null) return "N/A";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
}

function formatTokens(count: { input: number; output: number } | null): string {
  if (!count) return "N/A";
  const fmtNum = (n: number) => n.toLocaleString();
  return `${fmtNum(count.input)} in / ${fmtNum(count.output)} out`;
}

function StageDetailPanelComponent({ stage, detail, onViewConversation, onClose }: StageDetailPanelProps) {
  const statusColor = STATUS_COLORS[stage.status] || "var(--muted-foreground)";

  return (
    <div
      className="pipeline-detail-panel"
      style={{
        background: "var(--background)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        margin: "0 20px 16px",
        padding: "16px 20px",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: statusColor }}>
          {stage.name} -- {stage.status}
        </span>
        <button
          onClick={onClose}
          style={{
            fontSize: 11,
            color: "var(--muted-foreground)",
            cursor: "pointer",
            background: "none",
            border: "none",
            padding: "2px 6px",
            borderRadius: 3,
          }}
        >
          Close
        </button>
      </div>

      {/* Summary */}
      {(detail?.summary || stage.summary) && (
        <DetailRow label="Summary">
          <span
            style={{
              fontFamily: "inherit",
              color: "var(--foreground)",
              lineHeight: 1.6,
            }}
          >
            {detail?.summary || stage.summary}
          </span>
        </DetailRow>
      )}

      {/* Tool calls */}
      {detail && detail.toolCalls.length > 0 && (
        <DetailRow label="Tools">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {detail.toolCalls.map((t, i) => (
              <span
                key={i}
                style={{
                  fontSize: 10,
                  fontFamily: '"JetBrains Mono", monospace',
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: "var(--secondary)",
                  color: "var(--muted-foreground)",
                }}
              >
                {t.name}
                {t.args ? `(${t.args})` : ""}
              </span>
            ))}
          </div>
        </DetailRow>
      )}

      {/* Simple tool summary when no detail available */}
      {!detail && stage.toolCalls.length > 0 && (
        <DetailRow label="Tools">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {stage.toolCalls.map((t, i) => (
              <span
                key={i}
                style={{
                  fontSize: 10,
                  fontFamily: '"JetBrains Mono", monospace',
                  padding: "2px 8px",
                  borderRadius: 4,
                  background: "var(--secondary)",
                  color: "var(--muted-foreground)",
                }}
              >
                {t.name}({t.count})
              </span>
            ))}
          </div>
        </DetailRow>
      )}

      {/* Duration */}
      <DetailRow label="Duration">
        <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: "var(--foreground)" }}>
          {formatDuration(stage.duration)}
        </span>
      </DetailRow>

      {/* Tokens */}
      {(detail?.tokenCount || stage.tokenCount) && (
        <DetailRow label="Tokens">
          <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: "var(--foreground)" }}>
            {formatTokens(detail?.tokenCount || stage.tokenCount)}
          </span>
        </DetailRow>
      )}

      {/* Cost */}
      {(detail?.cost !== undefined || stage.cost !== null) && (
        <DetailRow label="Cost">
          <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: "#34d399" }}>
            ${(detail?.cost ?? stage.cost ?? 0).toFixed(2)}
          </span>
        </DetailRow>
      )}

      {/* On failure */}
      {stage.on_failure && (
        <DetailRow label="On failure">
          <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: "#fbbf24" }}>
            {stage.on_failure}
          </span>
        </DetailRow>
      )}

      {/* Review findings */}
      {detail?.reviewFindings && detail.reviewFindings.length > 0 && (
        <DetailRow label="Findings">
          <div style={{ fontSize: 11, color: "var(--foreground)", lineHeight: 1.6 }}>
            {detail.reviewFindings.map((f, i) => (
              <div key={i}>- {f}</div>
            ))}
          </div>
        </DetailRow>
      )}

      {/* View conversation link */}
      {onViewConversation && (
        <div style={{ marginTop: 8 }}>
          <button
            onClick={onViewConversation}
            style={{
              fontSize: 11,
              color: "var(--primary)",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
              textDecoration: "none",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
            onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
          >
            View full conversation
          </button>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 8, fontSize: 12 }}>
      <span style={{ width: 80, flexShrink: 0, color: "var(--muted-foreground)", fontSize: 11 }}>{label}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

export const StageDetailPanel = memo(StageDetailPanelComponent);

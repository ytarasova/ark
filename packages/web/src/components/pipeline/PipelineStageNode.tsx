/**
 * Custom @xyflow/react node for rendering a pipeline stage.
 *
 * Shows stage name, agent, duration, cost, and a gate icon badge.
 * Border color reflects the stage status (completed/running/pending/failed/waiting).
 */

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { PipelineStage, GateType } from "./types.js";

export interface StageNodeData extends Record<string, unknown> {
  stage: PipelineStage;
  isExpanded: boolean;
  onClick: (stageName: string) => void;
}

const GATE_ICONS: Record<GateType, string> = {
  auto: "\u26A1", // lightning bolt
  manual: "\u270B", // raised hand
  condition: "\u2753", // question mark
  review: "\uD83D\uDC41\uFE0F", // eye
};

function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
}

function formatCost(cost: number | null): string {
  if (cost === null) return "";
  return `$${cost.toFixed(2)}`;
}

function PipelineStageNodeComponent({ data }: NodeProps) {
  const { stage, onClick } = data as unknown as StageNodeData;

  return (
    <div
      className={`pipeline-stage-node status-${stage.status}${(data as unknown as StageNodeData).isExpanded ? " expanded" : ""}`}
      onClick={() => onClick(stage.name)}
    >
      {/* Connection handles */}
      <Handle type="target" position={Position.Left} style={{ opacity: 0, width: 8, height: 8 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0, width: 8, height: 8 }} />

      {/* Status dot */}
      {stage.status !== "pending" && <div className={`pipeline-stage-status-dot ${stage.status}`} />}

      {/* Gate icon */}
      <span className="pipeline-stage-gate-icon" title={`${stage.gate} gate`}>
        {GATE_ICONS[stage.gate]}
      </span>

      {/* Content */}
      <div className="pipeline-stage-name">{stage.name}</div>
      <div className="pipeline-stage-agent">{stage.agent || stage.action || ""}</div>
      {stage.duration !== null && (
        <div className="pipeline-stage-duration">
          {formatDuration(stage.duration)}
          {stage.status === "running" ? "..." : ""}
        </div>
      )}
      {stage.cost !== null && stage.status === "completed" && (
        <div className="pipeline-stage-cost">{formatCost(stage.cost)}</div>
      )}
    </div>
  );
}

export const PipelineStageNode = memo(PipelineStageNodeComponent);

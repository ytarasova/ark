/**
 * Custom @xyflow/react edge for pipeline visualization.
 *
 * Supports animated dashed lines for active edges, solid for completed,
 * dotted gray for pending, and conditional edge labels.
 */

import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";

export interface PipelineEdgeData extends Record<string, unknown> {
  condition: string | null;
  label: string | null;
  edgeType: "linear" | "fanout" | "conditional" | "loopback";
  isActive: boolean;
  isTaken: boolean;
}

function PipelineEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps) {
  const edgeData = (data || {}) as PipelineEdgeData;
  const { condition, label, edgeType, isActive, isTaken } = edgeData;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  // Determine edge style based on type and state
  let stroke = "var(--border)";
  const strokeWidth = 2;
  let strokeDasharray: string | undefined;
  let opacity = 1;
  let className = "";

  if (isActive) {
    stroke = "var(--primary)";
    strokeDasharray = "8 4";
    className = "pipeline-edge-active";
  } else if (isTaken) {
    stroke = "#34d399";
    opacity = 0.5;
  } else if (edgeType === "conditional") {
    stroke = "#fbbf24";
    strokeDasharray = "6 3";
    opacity = 0.6;
  } else if (edgeType === "loopback") {
    stroke = "#22d3ee";
    strokeDasharray = "4 3";
    opacity = 0.5;
  } else if (edgeType === "linear" && !isTaken && !isActive) {
    // Pending edge
    opacity = 0.4;
  }

  const displayLabel = label || condition;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke,
          strokeWidth,
          strokeDasharray,
          opacity,
        }}
        className={className}
      />
      {displayLabel && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
              fontSize: 9,
              fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
              color:
                edgeType === "loopback"
                  ? "#22d3ee"
                  : edgeType === "conditional"
                    ? "#fbbf24"
                    : "var(--muted-foreground)",
              background: "var(--card)",
              padding: "1px 6px",
              borderRadius: 3,
              whiteSpace: "nowrap",
            }}
          >
            {displayLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const PipelineEdge = memo(PipelineEdgeComponent);

/**
 * PipelineViewer -- the main session pipeline visualization component.
 *
 * Takes stages with status/timing, edges with conditions, and the current
 * active stage. Uses @xyflow/react for DAG rendering and d3-dag for
 * auto-calculating node positions (left-to-right layout).
 *
 * Read-only -- no editing, just viewing session progress.
 */

import { useState, useMemo, useCallback } from "react";
import { ReactFlow, Controls, Background, BackgroundVariant, MarkerType, type Node, type Edge } from "@xyflow/react";
import { PipelineStageNode, type StageNodeData } from "./PipelineStageNode.js";
import { PipelineEdge, type PipelineEdgeData } from "./PipelineEdge.js";
import { StageDetailPanel } from "./StageDetailPanel.js";
import { PipelineFanoutGroup } from "./PipelineFanoutGroup.js";
import { layoutPipeline, separateBackEdges } from "./layout.js";
import type { PipelineStage, PipelineEdge as PipelineEdgeType, StageDetailData } from "./types.js";
import "./pipeline.css";

export interface PipelineViewerProps {
  stages: PipelineStage[];
  edges: PipelineEdgeType[];
  currentStage: string | null;
  onStageClick?: (stageName: string) => void;
  onViewConversation?: (stageName: string) => void;
  stageDetails?: Record<string, StageDetailData>;
  sessionName?: string;
  flowName?: string;
  totalDuration?: string;
  totalCost?: number;
}

const nodeTypes = {
  stageNode: PipelineStageNode,
};

const edgeTypes = {
  pipelineEdge: PipelineEdge,
};

function determineEdgeType(
  edge: PipelineEdgeType,
  backEdges: PipelineEdgeType[],
): "linear" | "fanout" | "conditional" | "loopback" {
  if (backEdges.some((b) => b.from === edge.from && b.to === edge.to)) {
    return "loopback";
  }
  if (edge.condition || edge.label) {
    return "conditional";
  }
  return "linear";
}

function isEdgeActive(edge: PipelineEdgeType, currentStage: string | null, stages: PipelineStage[]): boolean {
  if (!currentStage) return false;
  const sourceStage = stages.find((s) => s.name === edge.from);
  return edge.to === currentStage && sourceStage?.status === "completed";
}

function isEdgeTaken(edge: PipelineEdgeType, stages: PipelineStage[]): boolean {
  const target = stages.find((s) => s.name === edge.to);
  const source = stages.find((s) => s.name === edge.from);
  return source?.status === "completed" && (target?.status === "completed" || target?.status === "running");
}

export function PipelineViewer({
  stages,
  edges,
  currentStage,
  onStageClick,
  onViewConversation,
  stageDetails,
  sessionName,
  flowName,
  totalDuration,
  totalCost,
}: PipelineViewerProps) {
  const [expandedStage, setExpandedStage] = useState<string | null>(null);
  const [expandedFanout, setExpandedFanout] = useState<string | null>(null);

  const handleStageClick = useCallback(
    (stageName: string) => {
      const stage = stages.find((s) => s.name === stageName);
      if (stage?.type === "fan_out" && stage.workers) {
        setExpandedFanout(expandedFanout === stageName ? null : stageName);
        setExpandedStage(null);
      } else {
        setExpandedStage(expandedStage === stageName ? null : stageName);
        setExpandedFanout(null);
      }
      onStageClick?.(stageName);
    },
    [stages, expandedStage, expandedFanout, onStageClick],
  );

  const { backEdges } = useMemo(() => separateBackEdges(stages, edges), [stages, edges]);

  // Compute layout
  const layoutResults = useMemo(() => layoutPipeline(stages, edges), [stages, edges]);

  // Convert to @xyflow/react nodes
  const flowNodes: Node[] = useMemo(() => {
    return layoutResults.map((result) => ({
      id: result.id,
      type: "stageNode",
      position: result.position,
      data: {
        stage: result.data,
        isExpanded: expandedStage === result.id,
        onClick: handleStageClick,
      } satisfies StageNodeData as StageNodeData & Record<string, unknown>,
      draggable: false,
      selectable: false,
    }));
  }, [layoutResults, expandedStage, handleStageClick]);

  // Convert to @xyflow/react edges
  const flowEdges: Edge[] = useMemo(() => {
    return edges.map((edge) => {
      const edgeType = determineEdgeType(edge, backEdges);
      const active = isEdgeActive(edge, currentStage, stages);
      const taken = isEdgeTaken(edge, stages);

      return {
        id: `${edge.from}->${edge.to}`,
        source: edge.from,
        target: edge.to,
        type: "pipelineEdge",
        data: {
          condition: edge.condition,
          label: edge.label,
          edgeType,
          isActive: active,
          isTaken: taken,
        } satisfies PipelineEdgeData as PipelineEdgeData & Record<string, unknown>,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: active ? "var(--primary)" : taken ? "var(--completed)" : "var(--border)",
        },
        animated: active,
      };
    });
  }, [edges, backEdges, currentStage, stages]);

  // Selected stage for detail panel
  const selectedStage = expandedStage ? stages.find((s) => s.name === expandedStage) : null;
  const selectedDetail = expandedStage && stageDetails ? stageDetails[expandedStage] : null;

  // Fan-out stage for expanded comparison
  const fanoutStage = expandedFanout ? stages.find((s) => s.name === expandedFanout) : null;

  return (
    <div
      className="pipeline-flow-container"
      style={{
        width: "100%",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        border: "1px solid var(--border)",
        background: "var(--bg-card)",
      }}
    >
      {/* Header */}
      {(sessionName || flowName) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 20px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {sessionName && <span style={{ fontSize: 14, fontWeight: 600, color: "var(--fg)" }}>{sessionName}</span>}
            {flowName && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "2px 8px",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--primary-subtle)",
                  color: "var(--primary)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                {flowName}
              </span>
            )}
          </div>
          {(totalDuration || totalCost !== undefined) && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 11,
                color: "var(--fg-muted)",
                fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace',
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {totalDuration && <span>{totalDuration}</span>}
              {totalCost !== undefined && (
                <span
                  style={{
                    fontSize: 10,
                    padding: "2px 8px",
                    borderRadius: "var(--radius-sm)",
                    background: "rgba(52, 211, 153, 0.12)",
                    color: "var(--completed)",
                    fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace',
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  ${totalCost.toFixed(2)}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* DAG viewport */}
      <div style={{ height: 240, width: "100%" }}>
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          preventScrolling={false}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
          minZoom={0.3}
          maxZoom={2}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {/* Detail panel for selected stage */}
      {selectedStage && (
        <StageDetailPanel
          stage={selectedStage}
          detail={selectedDetail || null}
          onViewConversation={onViewConversation ? () => onViewConversation(selectedStage.name) : undefined}
          onClose={() => setExpandedStage(null)}
        />
      )}

      {/* Fan-out comparison panel */}
      {fanoutStage && fanoutStage.workers && (
        <PipelineFanoutGroup
          parentStage={fanoutStage.name}
          joinStage=""
          workers={fanoutStage.workers}
          isExpanded={true}
          onToggle={() => setExpandedFanout(null)}
        />
      )}

      {/* Legend */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "10px 20px",
          borderTop: "1px solid var(--border)",
          fontSize: 10,
          color: "var(--fg-muted)",
          opacity: 0.7,
        }}
      >
        <LegendItem color="var(--completed)" label="Completed" />
        <LegendItem color="var(--primary)" label="Running" />
        <LegendItem color="var(--border)" label="Pending" />
        <LegendItem color="var(--failed)" label="Failed" />
        <LegendItem color="var(--waiting)" label="Waiting" />
      </div>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 3,
          border: `2px solid ${color}`,
          background: color === "var(--border)" ? "transparent" : `${color}20`,
          display: "inline-block",
        }}
      />
      {label}
    </div>
  );
}

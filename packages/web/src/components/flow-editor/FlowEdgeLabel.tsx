/**
 * Custom edge for the flow editor with editable condition labels.
 *
 * Styles: solid (linear), dashed amber (conditional), dashed cyan (loopback).
 * Double-click the label to edit the condition expression.
 */

import { memo, useState, useCallback } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";

export interface FlowEdgeLabelData extends Record<string, unknown> {
  condition: string | null;
  label: string | null;
  edgeType: "linear" | "conditional" | "loopback";
  readOnly: boolean;
  onConditionChange?: (edgeId: string, condition: string) => void;
}

function FlowEdgeLabelComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  selected,
}: EdgeProps) {
  const edgeData = (data || {}) as FlowEdgeLabelData;
  const { condition, label, edgeType, readOnly, onConditionChange } = edgeData;
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(condition || label || "");

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  let stroke = "var(--border)";
  let strokeDasharray: string | undefined;
  let opacity = 1;

  if (edgeType === "conditional") {
    stroke = "var(--waiting)";
    strokeDasharray = "6 3";
    opacity = 0.6;
  } else if (edgeType === "loopback") {
    stroke = "var(--running)";
    strokeDasharray = "4 3";
    opacity = 0.5;
  }

  if (selected) {
    stroke = "var(--primary)";
    opacity = 1;
  }

  const handleDoubleClick = useCallback(() => {
    if (readOnly) return;
    setEditValue(condition || label || "");
    setEditing(true);
  }, [readOnly, condition, label]);

  const handleBlur = useCallback(() => {
    setEditing(false);
    if (onConditionChange) {
      onConditionChange(id, editValue);
    }
  }, [id, editValue, onConditionChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        handleBlur();
      } else if (e.key === "Escape") {
        setEditing(false);
      }
    },
    [handleBlur],
  );

  const displayLabel = label || condition;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{ stroke, strokeWidth: 2, strokeDasharray, opacity }}
      />
      {(displayLabel || editing) && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            onDoubleClick={handleDoubleClick}
          >
            {editing ? (
              <input
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                style={{
                  fontSize: 9,
                  fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace',
                  background: "var(--bg-input)",
                  border: "1px solid var(--primary)",
                  borderRadius: "var(--radius-sm)",
                  padding: "2px 6px",
                  color: "var(--fg)",
                  outline: "none",
                  minWidth: 60,
                }}
              />
            ) : (
              <span
                style={{
                  fontSize: 9,
                  fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace',
                  color:
                    edgeType === "loopback"
                      ? "var(--running)"
                      : edgeType === "conditional"
                        ? "var(--waiting)"
                        : "var(--fg-muted)",
                  background: "var(--bg-card)",
                  padding: "1px 6px",
                  borderRadius: "var(--radius-sm)",
                  whiteSpace: "nowrap",
                  cursor: readOnly ? "default" : "text",
                }}
              >
                {displayLabel}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const FlowEdgeLabel = memo(FlowEdgeLabelComponent);

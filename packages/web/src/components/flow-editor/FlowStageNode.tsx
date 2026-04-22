/**
 * Editable flow stage node for the FlowEditor.
 *
 * Shows: name, agent, gate badge, outcome routes, connection handles.
 * Supports selection highlighting and displays verify/failure info.
 */

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { FlowStageDefinition } from "../pipeline/types.js";

export interface FlowStageNodeData extends Record<string, unknown> {
  stage: FlowStageDefinition;
  isSelected: boolean;
  onClick: (stageName: string) => void;
  readOnly: boolean;
}

function FlowStageNodeComponent({ data, selected }: NodeProps) {
  const { stage, onClick, readOnly } = data as unknown as FlowStageNodeData;

  const gateClass =
    stage.gate === "auto"
      ? "gate-auto"
      : stage.gate === "manual"
        ? "gate-manual"
        : stage.gate === "condition"
          ? "gate-condition"
          : "gate-review";

  return (
    <div
      className={`flow-editor-node${selected ? " selected" : ""}`}
      onClick={() => onClick(stage.name)}
      style={{ cursor: readOnly ? "default" : "grab" }}
    >
      {/* Connection handles */}
      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: 10,
          height: 10,
          background: "var(--secondary)",
          border: "2px solid var(--border)",
          cursor: readOnly ? "default" : "crosshair",
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{
          width: 10,
          height: 10,
          background: "var(--secondary)",
          border: "2px solid var(--border)",
          cursor: readOnly ? "default" : "crosshair",
        }}
      />

      {/* Header */}
      <div className="flow-editor-node-header">
        <span className="flow-editor-node-name">{stage.name}</span>
        <span className={`gate-badge ${gateClass}`}>{stage.gate}</span>
      </div>

      {/* Body */}
      <div className="flow-editor-node-body">
        {stage.agent && (
          <div className="flow-editor-node-field">
            <span className="flow-editor-node-field-label">Agent</span>
            <span className="flow-editor-node-field-value">{stage.agent}</span>
          </div>
        )}
        {stage.action && (
          <div className="flow-editor-node-field">
            <span className="flow-editor-node-field-label">Action</span>
            <span className="flow-editor-node-field-value">{stage.action}</span>
          </div>
        )}

        {/* Verify scripts indicator */}
        {stage.verify && stage.verify.length > 0 && (
          <div
            style={{
              fontSize: 9,
              fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace',
              color: "var(--running)",
              marginTop: 4,
              paddingTop: 4,
              borderTop: "1px solid var(--border)",
            }}
          >
            verify: {stage.verify.length} script{stage.verify.length > 1 ? "s" : ""}
          </div>
        )}

        {/* On failure */}
        {stage.on_failure && (
          <div
            style={{
              fontSize: 9,
              fontFamily: 'var(--font-mono-ui, "Geist Mono"), "JetBrains Mono", monospace',
              color: "var(--waiting)",
              marginTop: 2,
            }}
          >
            on_failure: {stage.on_failure}
          </div>
        )}

        {/* Outcome routes */}
        {stage.on_outcome && Object.keys(stage.on_outcome).length > 0 && (
          <div style={{ marginTop: 4, paddingTop: 4, borderTop: "1px solid var(--border)" }}>
            {Object.entries(stage.on_outcome).map(([label, target]) => (
              <div key={label} className="flow-editor-outcome">
                <span className="flow-editor-outcome-label">{label}</span>
                <span className="flow-editor-outcome-arrow">-&gt;</span>
                <span className="flow-editor-outcome-target">{target}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const FlowStageNode = memo(FlowStageNodeComponent);

/**
 * FlowEditor -- the DAG editor for creating/viewing flow definitions.
 *
 * Uses @xyflow/react with editing enabled (drag nodes, connect edges).
 * Dot-grid background. View mode (read-only) and Edit mode (interactive).
 * Toolbar with: Add Stage, Auto-layout, Validate, Export YAML, Import YAML.
 */

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type OnConnect,
} from "@xyflow/react";
import { FlowStageNode, type FlowStageNodeData } from "./FlowStageNode.js";
import { FlowEdgeLabel, type FlowEdgeLabelData } from "./FlowEdgeLabel.js";
import { FlowPropertiesPanel } from "./FlowPropertiesPanel.js";
import { FlowToolbar } from "./FlowToolbar.js";
import { layoutPipeline, validateDag } from "../pipeline/layout.js";
import type {
  FlowDefinition,
  FlowStageDefinition,
  FlowEdgeDefinition,
  PipelineStage,
  PipelineEdge,
} from "../pipeline/types.js";
import "../pipeline/pipeline.css";

export interface FlowEditorProps {
  flow: FlowDefinition;
  onChange?: (flow: FlowDefinition) => void;
  readOnly?: boolean;
  agents?: string[];
}

const nodeTypes = {
  flowStage: FlowStageNode,
};

const edgeTypes = {
  flowEdge: FlowEdgeLabel,
};

/** Convert FlowStageDefinition to PipelineStage for layout computation. */
function toPipelineStage(stage: FlowStageDefinition): PipelineStage {
  return {
    name: stage.name,
    agent: stage.agent,
    action: stage.action,
    type: stage.type === "fan_out" ? "fan_out" : "normal",
    gate: (stage.gate as any) || "auto",
    status: "pending",
    duration: null,
    cost: null,
    model: null,
    tokenCount: null,
    summary: null,
    toolCalls: [],
    on_failure: stage.on_failure,
    verify: stage.verify,
    depends_on: stage.depends_on,
    workers: null,
  };
}

/** Convert FlowEdgeDefinition to PipelineEdge for layout computation. */
function toPipelineEdge(edge: FlowEdgeDefinition): PipelineEdge {
  return {
    from: edge.from,
    to: edge.to,
    condition: edge.condition,
    label: edge.label,
    isBackEdge: false,
  };
}

function determineEdgeType(edge: FlowEdgeDefinition, backEdgeSet: Set<string>): "linear" | "conditional" | "loopback" {
  const key = `${edge.from}->${edge.to}`;
  if (backEdgeSet.has(key)) return "loopback";
  if (edge.condition || edge.label) return "conditional";
  return "linear";
}

export function FlowEditor({ flow, onChange, readOnly: initialReadOnly = false, agents = [] }: FlowEditorProps) {
  const [readOnly, setReadOnly] = useState(initialReadOnly);
  const [selectedStage, setSelectedStage] = useState<string | null>(null);
  const [currentFlow, setCurrentFlow] = useState<FlowDefinition>(flow);
  const nodeIdCounter = useRef(0);

  // Compute layout positions
  const layoutResults = useMemo(() => {
    const pipelineStages = currentFlow.stages.map(toPipelineStage);
    const pipelineEdges = currentFlow.edges.map(toPipelineEdge);
    return layoutPipeline(pipelineStages, pipelineEdges);
  }, [currentFlow]);

  // Detect back edges for styling
  const backEdgeSet = useMemo(() => {
    const pipelineStages = currentFlow.stages.map(toPipelineStage);
    const pipelineEdges = currentFlow.edges.map(toPipelineEdge);
    // Compute back edges using Kahn's algorithm (same logic as separateBackEdges)
    const stageNames = new Set(pipelineStages.map((s) => s.name));
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    for (const s of pipelineStages) {
      inDegree.set(s.name, 0);
      adjacency.set(s.name, []);
    }
    const nonExplicitBack = pipelineEdges.filter((e) => !e.isBackEdge);
    for (const e of nonExplicitBack) {
      if (stageNames.has(e.from) && stageNames.has(e.to)) {
        adjacency.get(e.from)!.push(e.to);
        inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
      }
    }
    const queue: string[] = [];
    for (const [name, deg] of inDegree) {
      if (deg === 0) queue.push(name);
    }
    const orderIndex = new Map<string, number>();
    let idx = 0;
    while (queue.length > 0) {
      const node = queue.shift()!;
      orderIndex.set(node, idx++);
      for (const neighbor of adjacency.get(node) || []) {
        const newDeg = (inDegree.get(neighbor) || 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }
    const backSet = new Set<string>();
    for (const e of pipelineEdges) {
      const fromIdx = orderIndex.get(e.from);
      const toIdx = orderIndex.get(e.to);
      if (e.isBackEdge || fromIdx === undefined || toIdx === undefined || fromIdx >= toIdx) {
        backSet.add(`${e.from}->${e.to}`);
      }
    }
    return backSet;
  }, [currentFlow]);

  // Declared early so `initialEdges` below can reference it. Uses setCurrentFlow
  // directly since `updateFlow` (with the `onChange` side-effect) is declared
  // later. Keeping a single handleConditionChange avoids a circular hoisting
  // problem between initialEdges and updateFlow.
  const handleConditionChange = useCallback(
    (edgeId: string, condition: string) => {
      const [from, to] = edgeId.split("->");
      setCurrentFlow((prev) => {
        const next = {
          ...prev,
          edges: prev.edges.map((e) => (`${e.from}->${e.to}` === edgeId ? { ...e, condition: condition || null } : e)),
        };
        onChange?.(next);
        // Silence the linter for `from`/`to` being consumed via the template
        // match above -- kept for clarity when reading in place.
        void from;
        void to;
        return next;
      });
    },
    [onChange],
  );

  // Build initial nodes and edges for ReactFlow
  const initialNodes: Node[] = useMemo(
    () =>
      layoutResults.map((result) => {
        const stage = currentFlow.stages.find((s) => s.name === result.id)!;
        return {
          id: result.id,
          type: "flowStage",
          position: result.position,
          data: {
            stage,
            isSelected: selectedStage === result.id,
            onClick: (name: string) => setSelectedStage(name),
            readOnly,
          } satisfies FlowStageNodeData as FlowStageNodeData & Record<string, unknown>,
          draggable: !readOnly,
          selectable: true,
        };
      }),
    [layoutResults, currentFlow.stages, selectedStage, readOnly],
  );

  const initialEdges: Edge[] = useMemo(
    () =>
      currentFlow.edges.map((edge) => {
        const edgeType = determineEdgeType(edge, backEdgeSet);
        return {
          id: `${edge.from}->${edge.to}`,
          source: edge.from,
          target: edge.to,
          type: "flowEdge",
          data: {
            condition: edge.condition,
            label: edge.label,
            edgeType,
            readOnly,
            onConditionChange: handleConditionChange,
          } satisfies FlowEdgeLabelData as FlowEdgeLabelData & Record<string, unknown>,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 16,
            height: 16,
            color:
              edgeType === "conditional"
                ? "var(--waiting)"
                : edgeType === "loopback"
                  ? "var(--running)"
                  : "var(--border)",
          },
        };
      }),
    [currentFlow.edges, backEdgeSet, readOnly, handleConditionChange],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Sync when flow changes externally. This is a side-effect (setState), so
  // it belongs in useEffect, not useMemo.
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  const updateFlow = useCallback(
    (newFlow: FlowDefinition) => {
      setCurrentFlow(newFlow);
      onChange?.(newFlow);
    },
    [onChange],
  );

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return;
      const newEdge: FlowEdgeDefinition = {
        from: connection.source!,
        to: connection.target!,
        condition: null,
        label: null,
      };
      updateFlow({
        ...currentFlow,
        edges: [...currentFlow.edges, newEdge],
      });
    },
    [readOnly, currentFlow, updateFlow],
  );

  const handleAddStage = useCallback(() => {
    const id = `stage-${++nodeIdCounter.current}`;
    const newStage: FlowStageDefinition = {
      name: id,
      agent: null,
      action: null,
      type: null,
      gate: "auto",
      task: null,
      depends_on: [],
      on_failure: null,
      verify: [],
      optional: false,
    };
    updateFlow({
      ...currentFlow,
      stages: [...currentFlow.stages, newStage],
    });
    setSelectedStage(id);
  }, [currentFlow, updateFlow]);

  const handleAutoLayout = useCallback(() => {
    const pipelineStages = currentFlow.stages.map(toPipelineStage);
    const pipelineEdges = currentFlow.edges.map(toPipelineEdge);
    const results = layoutPipeline(pipelineStages, pipelineEdges);

    setNodes((nds) =>
      nds.map((node) => {
        const result = results.find((r) => r.id === node.id);
        if (result) {
          return { ...node, position: result.position };
        }
        return node;
      }),
    );
  }, [currentFlow, setNodes]);

  const handleValidate = useCallback((): string[] => {
    return validateDag(currentFlow.stages, currentFlow.edges);
  }, [currentFlow]);

  const handleStageUpdate = useCallback(
    (updatedStage: FlowStageDefinition) => {
      updateFlow({
        ...currentFlow,
        stages: currentFlow.stages.map((s) => (s.name === selectedStage ? updatedStage : s)),
      });
    },
    [currentFlow, selectedStage, updateFlow],
  );

  const handleStageDelete = useCallback(() => {
    if (!selectedStage) return;
    updateFlow({
      ...currentFlow,
      stages: currentFlow.stages.filter((s) => s.name !== selectedStage),
      edges: currentFlow.edges.filter((e) => e.from !== selectedStage && e.to !== selectedStage),
    });
    setSelectedStage(null);
  }, [currentFlow, selectedStage, updateFlow]);

  const handleImport = useCallback(
    (imported: FlowDefinition) => {
      updateFlow(imported);
      setSelectedStage(null);
    },
    [updateFlow],
  );

  const handleToggleMode = useCallback(() => {
    setReadOnly((prev) => !prev);
  }, []);

  const selectedStageData = selectedStage ? currentFlow.stages.find((s) => s.name === selectedStage) || null : null;

  return (
    <div
      className="flow-editor-container"
      style={{ display: "grid", gridTemplateColumns: "1fr 300px", gridTemplateRows: "48px 1fr", height: "100%" }}
    >
      {/* Toolbar spans full width */}
      <div style={{ gridColumn: "1 / -1" }}>
        <FlowToolbar
          flowName={currentFlow.name}
          readOnly={readOnly}
          onToggleMode={handleToggleMode}
          onAddStage={handleAddStage}
          onAutoLayout={handleAutoLayout}
          onValidate={handleValidate}
          flow={currentFlow}
          onImport={handleImport}
        />
      </div>

      {/* Canvas */}
      <div style={{ position: "relative", background: "var(--background)", overflow: "hidden" }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={readOnly ? undefined : onNodesChange}
          onEdgesChange={readOnly ? undefined : onEdgesChange}
          onConnect={readOnly ? undefined : onConnect}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          panOnDrag
          zoomOnScroll
          zoomOnPinch
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable={true}
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
          maxZoom={3}
          onNodeClick={(_event, node) => setSelectedStage(node.id)}
          deleteKeyCode={readOnly ? null : "Delete"}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      {/* Properties panel */}
      <FlowPropertiesPanel
        stage={selectedStageData}
        agents={agents}
        allStageNames={currentFlow.stages.map((s) => s.name)}
        readOnly={readOnly}
        onUpdate={handleStageUpdate}
        onDelete={handleStageDelete}
      />
    </div>
  );
}

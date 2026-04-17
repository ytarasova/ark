# Pipeline Visualization Components

Specification for the DAG-based pipeline viewer and flow editor.

Replaces the current flat text pipeline (`plan > implement > verify > review > merge`)
with a topology-aware SVG+HTML visualization that handles linear, fan-out, and
conditional flows.

## Components

### PipelineViewer

Top-level session pipeline component. Renders the live pipeline for a running or
completed session.

```ts
interface PipelineViewerProps {
  stages: PipelineStage[];
  edges: PipelineEdge[];
  currentStage: string | null;
  onStageClick: (stageName: string) => void;
  collapsedHeight?: number; // default 120
  expandedHeight?: number;  // default 400
}
```

**Responsibilities:**
- Compute layout from stages + edges (see Layout Algorithm below)
- Render SVG edge layer (underneath) + HTML node layer (on top)
- Manage expand/collapse state per stage
- Subscribe to SSE for real-time status updates
- Auto-scroll to keep the active stage visible

### PipelineStageNode

Individual stage box rendered as a positioned HTML div overlaying the SVG canvas.

```ts
interface PipelineStageNodeProps {
  name: string;
  agent: string | null;
  action: string | null;
  model: string | null;
  gate: "auto" | "manual" | "condition" | "review";
  status: "completed" | "running" | "pending" | "failed" | "waiting";
  duration: number | null;  // milliseconds
  cost: number | null;      // USD
  tokenCount: { input: number; output: number } | null;
  isExpanded: boolean;
  onClick: () => void;
  position: { x: number; y: number };
}
```

**Visual states:**
| Status    | Border color | Background          | Animation        |
|-----------|-------------|---------------------|-----------------|
| completed | green       | green-subtle        | none            |
| running   | primary     | primary-subtle      | pulse glow      |
| pending   | border      | transparent         | none (dimmed)   |
| failed    | red         | red-subtle          | none            |
| waiting   | amber       | amber-subtle        | none            |

**Gate icons (top-right corner):**
- auto: lightning bolt
- manual: raised hand
- condition: question mark
- review: eye

### PipelineEdge

SVG path connecting two stage nodes.

```ts
interface PipelineEdgeProps {
  from: string;
  to: string;
  fromPosition: { x: number; y: number; width: number; height: number };
  toPosition: { x: number; y: number; width: number; height: number };
  condition: string | null;
  label: string | null;
  type: "linear" | "fanout" | "conditional" | "loopback";
  isActive: boolean;    // currently being traversed
  isTaken: boolean;     // was this path taken (for conditional)
}
```

**Edge rendering by type:**
- **linear**: Solid line, 2px, border color. Arrow at target.
- **fanout**: Solid line fanning from one source to N targets.
- **conditional**: Dashed line (6px dash, 3px gap), amber color. Label centered on path.
- **loopback**: Dashed line (4px dash, 3px gap), cyan color. Routes above the DAG.

**Active edge animation:** CSS `stroke-dashoffset` animation cycling at 1s, gives a
flowing-dots effect on the currently traversed edge.

### PipelineFanoutGroup

Renders parallel workers as a vertical stack at the same x-position, with shared
fan-out/fan-in edges.

```ts
interface PipelineFanoutGroupProps {
  parentStage: string;
  joinStage: string;
  workers: PipelineStage[];
  onWorkerClick: (workerName: string) => void;
  isExpanded: boolean;
}
```

**Expanded state (click any worker):**
Shows a horizontal grid below the pipeline with one cell per worker, each containing:
- Worker name + status badge
- Output summary (first 2-3 lines)
- Tool calls list
- Duration + cost
- "View conversation" link

### PipelineStageDetail

Expandable detail panel shown below the pipeline when a stage is clicked.

```ts
interface PipelineStageDetailProps {
  stage: PipelineStage;
  summary: string | null;
  toolCalls: { name: string; args: string; duration: number }[];
  tokenCount: { input: number; output: number };
  cost: number;
  reviewFindings: string[] | null;
  onViewConversation: () => void;
  onClose: () => void;
}
```

### FlowEditor

Full DAG editor for creating and modifying flow definitions.

```ts
interface FlowEditorProps {
  flow: FlowDefinition;
  onChange: (flow: FlowDefinition) => void;
  readOnly: boolean;
  agents: AgentDefinition[];
}
```

**Sub-components:**
- Canvas (SVG + positioned HTML nodes on a dot-grid background)
- Flow list sidebar (left, 240px)
- Properties panel (right, 300px)
- Toolbar (top)

**Interactions:**
- Drag nodes to reposition
- Drag from output port to input port to create edges
- Click node to select and show properties
- Double-click edge label to edit condition
- Delete key to remove selected node/edge
- Cmd+Z / Ctrl+Z for undo

### FlowStageProperties

Right-panel form for editing a selected stage.

```ts
interface FlowStagePropertiesProps {
  stage: FlowStageDefinition;
  agents: AgentDefinition[];
  allStageNames: string[];
  onUpdate: (stage: FlowStageDefinition) => void;
  onDelete: () => void;
}
```

**Fields:**
- Name (text input)
- Agent (dropdown from agents list)
- Gate (radio: auto / manual / condition)
- Condition expression (text input, visible when gate = condition)
- Verify scripts (textarea, multi-line)
- on_failure (dropdown: fail, retry(1), retry(2), retry(3))
- Outcome routes (key-value list: label -> target stage name)
- Task prompt (textarea)

### FlowEdgeLabel

Inline-editable label on a conditional edge.

```ts
interface FlowEdgeLabelProps {
  edge: FlowEdgeDefinition;
  onEdit: (edge: FlowEdgeDefinition) => void;
  position: { x: number; y: number };
}
```

---

## Layout Algorithm

The layout engine positions stage nodes on a 2D canvas. It operates in three passes.

### Pass 1: Topological ordering

```
function topoSort(stages, edges):
  inDegree = map each stage to count of incoming edges
  queue = stages where inDegree = 0
  order = []
  while queue not empty:
    stage = queue.shift()
    order.push(stage)
    for each edge from stage:
      inDegree[edge.to] -= 1
      if inDegree[edge.to] === 0:
        queue.push(edge.to)
  return order
```

Cycle detection: if `order.length < stages.length`, there are cycles. For loopback
edges (revise -> review), mark them as "back edges" and exclude from the topo sort.
Render them as curved paths routed above the DAG.

### Pass 2: Column assignment (left-to-right)

```
function assignColumns(order, edges):
  column = {}
  for stage in order:
    deps = stages that have an edge TO this stage (excluding back edges)
    if deps is empty:
      column[stage] = 0
    else:
      column[stage] = max(column[dep] for dep in deps) + 1
  return column
```

### Pass 3: Row assignment (vertical position within a column)

```
function assignRows(stages, columns):
  // Group stages by column
  groups = groupBy(stages, s => columns[s])
  row = {}
  for col in sorted(groups.keys()):
    stagesInCol = groups[col]
    // Center vertically
    startY = -(stagesInCol.length - 1) * (NODE_HEIGHT + GAP) / 2
    for i, stage in enumerate(stagesInCol):
      row[stage] = startY + i * (NODE_HEIGHT + GAP)
  return row
```

### Constants

```
NODE_WIDTH  = 140px
NODE_HEIGHT = 60px (minimum, grows with content in editor mode)
COLUMN_GAP  = 200px (horizontal spacing between columns)
ROW_GAP     = 16px (vertical spacing between nodes in same column)
PADDING     = 40px (canvas padding)
```

### Final position calculation

```
x(stage) = PADDING + column[stage] * COLUMN_GAP
y(stage) = canvasCenter + row[stage]
```

---

## SVG Path Calculation

### Linear edges

Horizontal bezier from source right edge to target left edge:

```
sourceX = source.x + NODE_WIDTH
sourceY = source.y + NODE_HEIGHT / 2
targetX = target.x
targetY = target.y + NODE_HEIGHT / 2
cpOffset = (targetX - sourceX) * 0.4

path = `M ${sourceX} ${sourceY}
        C ${sourceX + cpOffset} ${sourceY},
          ${targetX - cpOffset} ${targetY},
          ${targetX} ${targetY}`
```

### Fan-out edges

Same as linear but multiple targets. The control points spread vertically to avoid
overlapping:

```
for each target in targets:
  path = bezier from source center-right to target center-left
  // Control points use vertical midpoint to create smooth curves
```

### Conditional edges

Same path calculation as fan-out, but with dashed stroke and a label positioned at
the midpoint of the bezier curve:

```
labelX = (sourceX + targetX) / 2
labelY = (sourceY + targetY) / 2
```

### Loopback edges

Route above all nodes:

```
topY = min(all node Y positions) - 40px
path = `M ${sourceX + NODE_WIDTH} ${sourceY}
        C ${sourceX + NODE_WIDTH + 30} ${sourceY},
          ${sourceX + NODE_WIDTH + 30} ${topY},
          ${midX} ${topY}
        C ${targetX - 30} ${topY},
          ${targetX - 30} ${targetY},
          ${targetX} ${targetY}`
```

### Arrowheads

SVG marker-end with a triangle marker:

```svg
<marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5"
        markerWidth="8" markerHeight="8" orient="auto">
  <path d="M 0 0 L 10 5 L 0 10 z" />
</marker>
```

---

## Animation Specifications

### Running stage pulse

```css
@keyframes pulse-border {
  0%, 100% { box-shadow: 0 0 0 0 rgba(124,106,239,0.3); }
  50%      { box-shadow: 0 0 12px 2px rgba(124,106,239,0.2); }
}
.stage-node.running { animation: pulse-border 2s ease-in-out infinite; }
```

### Active edge flow

```css
@keyframes dash-flow {
  to { stroke-dashoffset: -24; }
}
.edge-path.active {
  stroke-dasharray: 8 4;
  animation: dash-flow 1s linear infinite;
}
```

### Detail panel expand

```css
@keyframes slide-down {
  from { opacity: 0; transform: translateY(-8px); }
}
.stage-detail { animation: slide-down 0.2s ease; }
```

---

## Data Types

```ts
interface PipelineStage {
  name: string;
  agent: string | null;
  action: string | null;
  type: "normal" | "fan_out";
  gate: "auto" | "manual" | "condition" | "review";
  status: "completed" | "running" | "pending" | "failed" | "waiting";
  duration: number | null;
  cost: number | null;
  tokenCount: { input: number; output: number } | null;
  summary: string | null;
  toolCalls: { name: string; count: number }[];
  on_failure: string | null;
  verify: string[] | null;
  depends_on: string[];
  workers: PipelineStage[] | null; // for fan_out stages
}

interface PipelineEdge {
  from: string;
  to: string;
  condition: string | null;
  label: string | null;
  isBackEdge: boolean;
}

interface FlowDefinition {
  name: string;
  description: string;
  stages: FlowStageDefinition[];
  edges: FlowEdgeDefinition[];
}

interface FlowStageDefinition {
  name: string;
  agent: string | null;
  action: string | null;
  type: string | null;
  gate: string;
  task: string | null;
  depends_on: string[];
  on_failure: string | null;
  verify: string[];
  optional: boolean;
}

interface FlowEdgeDefinition {
  from: string;
  to: string;
  condition: string | null;
  label: string | null;
}
```

---

## Integration Points

### PipelineViewer in SessionDetail

Replace the current `StagePipeline` component in the session header area.
Data source: `useSessionDetailData` hook already returns `stageProgress` --
extend it to include the full `PipelineStage[]` and `PipelineEdge[]` from the
session's flow definition + runtime status.

### FlowEditor in FlowsView

Replace the current linear pipeline rendering in `FlowsView.tsx`. The `useFlowDetail`
hook already returns stages and edges -- wire them into the `FlowEditor` component.

### SSE updates

The pipeline viewer subscribes to the existing SSE endpoint for stage transitions.
When a stage status changes, update the corresponding `PipelineStage.status` and
re-render. The edge animation state derives from the current stage.

---

## File locations

```
packages/web/src/components/pipeline/
  PipelineViewer.tsx
  PipelineStageNode.tsx
  PipelineEdge.tsx
  PipelineFanoutGroup.tsx
  PipelineStageDetail.tsx
  layout.ts              -- layout algorithm (topoSort, assignColumns, assignRows)
  paths.ts               -- SVG path calculation helpers
  types.ts               -- PipelineStage, PipelineEdge, etc.

packages/web/src/components/flow-editor/
  FlowEditor.tsx
  FlowCanvas.tsx
  FlowStageProperties.tsx
  FlowEdgeLabel.tsx
  FlowToolbar.tsx
  FlowSidebar.tsx
  useFlowEditorState.ts  -- undo/redo, selection, drag state
```

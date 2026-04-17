# Pipeline Visualization Components

DAG-based pipeline viewer and flow editor built with `@xyflow/react` + `d3-dag`.

## Components

### PipelineViewer

Read-only session pipeline visualization. Shows DAG topology with real-time stage status, expandable detail panels, and fan-out worker comparison.

```tsx
import { PipelineViewer } from "./pipeline/index.js";

<PipelineViewer
  stages={stages}           // PipelineStage[] -- stages with status/timing
  edges={edges}             // PipelineEdge[] -- edges with conditions
  currentStage="verify"     // currently active stage name (or null)
  onStageClick={(name) => console.log("clicked", name)}
  onViewConversation={(name) => navigate(`/session/${id}/${name}`)}
  stageDetails={detailMap}  // Record<string, StageDetailData> (optional)
  sessionName="s-a1f9 -- Add auth"
  flowName="autonomous-sdlc"
  totalDuration="4m 32s"
  totalCost={0.87}
/>
```

### FlowEditor

Interactive DAG editor for creating and modifying flow definitions.

```tsx
import { FlowEditor } from "./flow-editor/index.js";

<FlowEditor
  flow={flowDefinition}     // FlowDefinition -- stages + edges
  onChange={(updated) => saveFlow(updated)}
  readOnly={false}          // true = view mode, false = edit mode
  agents={["planner", "implementer", "reviewer"]}
/>
```

## Integration

### SessionDetail.tsx

Add `PipelineViewer` above the conversation panel as a collapsible section:

```tsx
import { PipelineViewer } from "./pipeline/index.js";

// Inside SessionDetail component:
const pipelineStages = buildPipelineStages(session, stageProgress);
const pipelineEdges = buildPipelineEdges(session.flow);

{showPipeline && (
  <PipelineViewer
    stages={pipelineStages}
    edges={pipelineEdges}
    currentStage={session.current_stage}
    onStageClick={handleStageClick}
    onViewConversation={(stage) => scrollToStage(stage)}
    sessionName={session.name}
    flowName={session.flow}
  />
)}
```

### FlowsView.tsx

Replace the flat pipeline display with `FlowEditor` in the right detail panel:

```tsx
import { FlowEditor } from "./flow-editor/index.js";

// Inside FlowsView, replace the Pipeline section with:
<FlowEditor
  flow={{
    name: selected.name,
    description: selected.description || "",
    stages: selected.stages.map(toFlowStageDefinition),
    edges: selected.edges || [],
  }}
  readOnly={true}
  agents={agents.map((a) => a.name)}
  onChange={(updated) => handleFlowUpdate(updated)}
/>
```

## Layout Algorithm

Uses d3-dag's Sugiyama algorithm (layered DAG layout):

1. **Separate back edges** -- detect and exclude loopback edges to make the graph acyclic
2. **Build DAG** -- use `graphStratify` with parent IDs derived from forward edges
3. **Run Sugiyama** -- layer assignment + edge crossing minimization + coordinate assignment
4. **Swap axes** -- d3-dag produces top-to-bottom layout; we swap x/y for left-to-right
5. **Map to ReactFlow** -- convert d3-dag positions to `@xyflow/react` node positions

Constants:
- `NODE_WIDTH`: 140px
- `NODE_HEIGHT`: 60px
- `COLUMN_GAP`: 200px (horizontal spacing)
- `ROW_GAP`: 16px (vertical spacing within a column)
- `PADDING`: 40px (canvas padding)

## File Structure

```
pipeline/
  PipelineViewer.tsx       -- main session pipeline component
  PipelineStageNode.tsx    -- custom @xyflow/react node (status-colored)
  PipelineEdge.tsx         -- custom @xyflow/react edge (animated/labeled)
  PipelineFanoutGroup.tsx  -- parallel worker comparison panel
  StageDetailPanel.tsx     -- expandable stage detail below pipeline
  layout.ts                -- d3-dag layout + validation + back edge detection
  types.ts                 -- shared TypeScript interfaces
  pipeline.css             -- styles (imports @xyflow/react base styles)
  index.ts                 -- barrel exports

flow-editor/
  FlowEditor.tsx           -- DAG editor with drag/connect/edit
  FlowStageNode.tsx        -- editable stage node with handles
  FlowEdgeLabel.tsx        -- edge with editable condition label
  FlowPropertiesPanel.tsx  -- right-side properties form
  FlowToolbar.tsx          -- toolbar (add, layout, validate, YAML)
  index.ts                 -- barrel exports
```

import type { PipelineEdge, PipelineStage } from "../../pipeline/types.js";

/** Convert flow definition stages to PipelineStage[] for the DAG viewer. */
export function flowStagesToPipeline(stages: any[]): PipelineStage[] {
  return (stages || []).map((s: any) => {
    const name = typeof s === "string" ? s : s.name;
    const gate = typeof s === "string" ? "auto" : s.gate || "auto";
    return {
      name,
      agent: typeof s === "string" ? null : s.agent || null,
      action: typeof s === "string" ? null : s.action || null,
      type: typeof s !== "string" && s.type === "fan_out" ? "fan_out" : "normal",
      gate: gate as "auto" | "manual" | "condition" | "review",
      status: "pending" as const,
      duration: null,
      cost: null,
      model: null,
      tokenCount: null,
      summary: null,
      toolCalls: [],
      on_failure: typeof s === "string" ? null : s.on_failure || null,
      verify: typeof s === "string" ? null : s.verify || null,
      depends_on: typeof s === "string" ? [] : s.depends_on || [],
      workers: null,
    };
  });
}

/** Build edges from explicit edges + depends_on + implicit linear chain. */
export function flowEdgesToPipeline(stages: any[], explicitEdges: any[]): PipelineEdge[] {
  const edges: PipelineEdge[] = [];
  const edgeSet = new Set<string>();

  for (const e of explicitEdges || []) {
    const key = `${e.from}->${e.to}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      edges.push({
        from: e.from,
        to: e.to,
        condition: e.condition || null,
        label: e.label || null,
        isBackEdge: false,
      });
    }
  }

  for (const s of stages || []) {
    if (typeof s === "string") continue;
    for (const dep of s.depends_on || []) {
      const key = `${dep}->${s.name}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push({ from: dep, to: s.name, condition: null, label: null, isBackEdge: false });
      }
    }
  }

  if (edges.length === 0 && stages && stages.length > 1) {
    for (let i = 1; i < stages.length; i++) {
      const prev = typeof stages[i - 1] === "string" ? stages[i - 1] : stages[i - 1].name;
      const curr = typeof stages[i] === "string" ? stages[i] : stages[i].name;
      edges.push({ from: prev, to: curr, condition: null, label: null, isBackEdge: false });
    }
  }

  return edges;
}

/**
 * DAG layout engine for pipeline visualization.
 *
 * Uses d3-dag's Sugiyama algorithm (layered DAG layout) to compute
 * node positions from stages + edges, then maps results to @xyflow/react
 * node positions (left-to-right orientation).
 */

import { graphStratify, sugiyama, decrossOpt, coordCenter } from "d3-dag";
import type { PipelineStage, PipelineEdge } from "./types.js";

// Layout constants (px)
export const NODE_WIDTH = 140;
export const NODE_HEIGHT = 60;
export const COLUMN_GAP = 200;
export const ROW_GAP = 16;
export const PADDING = 40;

interface LayoutNode {
  id: string;
  parentIds: string[];
  data: PipelineStage;
}

export interface LayoutResult {
  id: string;
  position: { x: number; y: number };
  data: PipelineStage;
}

/**
 * Separate back edges (loopbacks) from forward edges.
 * Back edges create cycles, which break topological layout.
 * We detect them explicitly via the isBackEdge flag, and also
 * run a simple cycle detection to catch unmarked ones.
 */
export function separateBackEdges(
  stages: PipelineStage[],
  edges: PipelineEdge[],
): { forwardEdges: PipelineEdge[]; backEdges: PipelineEdge[] } {
  const forwardEdges: PipelineEdge[] = [];
  const backEdges: PipelineEdge[] = [];

  // First pass: explicit back edges
  const candidateForward: PipelineEdge[] = [];
  for (const edge of edges) {
    if (edge.isBackEdge) {
      backEdges.push(edge);
    } else {
      candidateForward.push(edge);
    }
  }

  // Second pass: detect implicit cycles via DFS
  const stageNames = new Set(stages.map((s) => s.name));
  const adjacency = new Map<string, string[]>();
  for (const s of stages) {
    adjacency.set(s.name, []);
  }
  for (const e of candidateForward) {
    if (stageNames.has(e.from) && stageNames.has(e.to)) {
      adjacency.get(e.from)!.push(e.to);
    }
  }

  // Kahn's algorithm to detect which edges cause cycles
  const inDegree = new Map<string, number>();
  for (const s of stages) inDegree.set(s.name, 0);
  for (const e of candidateForward) {
    if (stageNames.has(e.to)) {
      inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }

  // If no roots found (full cycle), pick the first stage as root
  // and remove one edge to break the cycle minimally
  if (queue.length === 0 && stages.length > 0) {
    const firstStage = stages[0].name;
    queue.push(firstStage);
    inDegree.set(firstStage, 0);
    // Mark edges leading into the first stage as back edges
    for (const e of candidateForward) {
      if (e.to === firstStage) {
        backEdges.push(e);
      }
    }
    // Re-filter candidate forward to exclude those just marked as back edges
    const backEdgeKeys = new Set(backEdges.map((e) => `${e.from}->${e.to}`));
    const remaining = candidateForward.filter((e) => !backEdgeKeys.has(`${e.from}->${e.to}`));

    // Recompute in-degrees with remaining edges
    for (const s of stages) inDegree.set(s.name, 0);
    for (const e of remaining) {
      if (stageNames.has(e.to)) {
        inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
      }
    }
    // Rebuild adjacency
    for (const s of stages) adjacency.set(s.name, []);
    for (const e of remaining) {
      if (stageNames.has(e.from) && stageNames.has(e.to)) {
        adjacency.get(e.from)!.push(e.to);
      }
    }

    // Reset queue
    queue.length = 0;
    for (const [name, deg] of inDegree) {
      if (deg === 0) queue.push(name);
    }

    // Process remaining edges through topo sort
    const topoOrder: string[] = [];
    const orderIndex = new Map<string, number>();
    while (queue.length > 0) {
      const node = queue.shift()!;
      orderIndex.set(node, topoOrder.length);
      topoOrder.push(node);
      for (const neighbor of adjacency.get(node) || []) {
        const newDeg = (inDegree.get(neighbor) || 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) queue.push(neighbor);
      }
    }

    for (const e of remaining) {
      const fromIdx = orderIndex.get(e.from);
      const toIdx = orderIndex.get(e.to);
      if (fromIdx === undefined || toIdx === undefined || fromIdx >= toIdx) {
        backEdges.push(e);
      } else {
        forwardEdges.push(e);
      }
    }

    return { forwardEdges, backEdges };
  }

  const topoOrder: string[] = [];
  const orderIndex = new Map<string, number>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    orderIndex.set(node, topoOrder.length);
    topoOrder.push(node);
    for (const neighbor of adjacency.get(node) || []) {
      const newDeg = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  // Edges that go backward in topo order (or involve nodes not in topo order) are back edges
  for (const e of candidateForward) {
    const fromIdx = orderIndex.get(e.from);
    const toIdx = orderIndex.get(e.to);
    if (fromIdx === undefined || toIdx === undefined || fromIdx >= toIdx) {
      backEdges.push(e);
    } else {
      forwardEdges.push(e);
    }
  }

  return { forwardEdges, backEdges };
}

/**
 * Compute DAG layout using d3-dag Sugiyama algorithm.
 *
 * Returns node positions in left-to-right orientation suitable for
 * @xyflow/react's coordinate system.
 */
export function layoutPipeline(stages: PipelineStage[], edges: PipelineEdge[]): LayoutResult[] {
  if (stages.length === 0) return [];

  const { forwardEdges } = separateBackEdges(stages, edges);

  // Build parent map for d3-dag stratify
  const stageNames = new Set(stages.map((s) => s.name));
  const parentMap = new Map<string, string[]>();
  for (const s of stages) {
    parentMap.set(s.name, []);
  }
  for (const e of forwardEdges) {
    if (stageNames.has(e.from) && stageNames.has(e.to)) {
      parentMap.get(e.to)!.push(e.from);
    }
  }

  // Build nodes for d3-dag
  const layoutNodes: LayoutNode[] = stages.map((s) => ({
    id: s.name,
    parentIds: parentMap.get(s.name) || [],
    data: s,
  }));

  try {
    // Create DAG using graphStratify
    const stratify = graphStratify();
    const dag = stratify(layoutNodes);

    // Run Sugiyama layout with explicit node sizing.
    // d3-dag lays out top-to-bottom, so "width" in nodeSize is horizontal
    // spacing and "height" is vertical (layer) spacing.
    // We swap axes after layout to get left-to-right.
    const layout = sugiyama()
      .nodeSize([NODE_HEIGHT + ROW_GAP, NODE_WIDTH + (COLUMN_GAP - NODE_WIDTH)])
      .decross(decrossOpt())
      .coord(coordCenter());

    layout(dag);

    // Extract positions -- swap x/y for left-to-right orientation
    const results: LayoutResult[] = [];
    for (const node of dag.nodes()) {
      const stageData = stages.find((s) => s.name === node.data.id);
      if (!stageData) continue;

      results.push({
        id: node.data.id,
        position: {
          // d3-dag y = layer depth -> our x (horizontal)
          // d3-dag x = cross position -> our y (vertical)
          x: PADDING + node.y,
          y: PADDING + node.x,
        },
        data: stageData,
      });
    }

    return results;
  } catch {
    // Fallback: simple linear layout if d3-dag fails
    return stages.map((s, i) => ({
      id: s.name,
      position: {
        x: PADDING + i * COLUMN_GAP,
        y: PADDING,
      },
      data: s,
    }));
  }
}

/**
 * Simplified layout that uses manual column/row assignment.
 * Used as a fallback and for the flow editor's auto-layout feature.
 */
export function layoutManual(stages: PipelineStage[], edges: PipelineEdge[]): LayoutResult[] {
  if (stages.length === 0) return [];

  const { forwardEdges } = separateBackEdges(stages, edges);

  // Topo sort
  const stageNames = new Set(stages.map((s) => s.name));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const s of stages) {
    inDegree.set(s.name, 0);
    adjacency.set(s.name, []);
  }
  for (const e of forwardEdges) {
    if (stageNames.has(e.from) && stageNames.has(e.to)) {
      adjacency.get(e.from)!.push(e.to);
      inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node);
    for (const neighbor of adjacency.get(node) || []) {
      const newDeg = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  // Add any nodes not in topo order (part of cycles)
  for (const s of stages) {
    if (!order.includes(s.name)) order.push(s.name);
  }

  // Column assignment: longest path from roots
  const column = new Map<string, number>();
  for (const name of order) {
    const parents = forwardEdges.filter((e) => e.to === name).map((e) => e.from);
    if (parents.length === 0) {
      column.set(name, 0);
    } else {
      const maxParentCol = Math.max(...parents.map((p) => column.get(p) ?? 0));
      column.set(name, maxParentCol + 1);
    }
  }

  // Row assignment: group by column, center vertically
  const groups = new Map<number, string[]>();
  for (const name of order) {
    const col = column.get(name) ?? 0;
    if (!groups.has(col)) groups.set(col, []);
    groups.get(col)!.push(name);
  }

  const row = new Map<string, number>();
  for (const [, stagesInCol] of groups) {
    const startY = (-(stagesInCol.length - 1) * (NODE_HEIGHT + ROW_GAP)) / 2;
    stagesInCol.forEach((name, i) => {
      row.set(name, startY + i * (NODE_HEIGHT + ROW_GAP));
    });
  }

  // Compute center Y for centering
  const canvasCenter = 200; // arbitrary center offset

  return stages.map((s) => ({
    id: s.name,
    position: {
      x: PADDING + (column.get(s.name) ?? 0) * COLUMN_GAP,
      y: canvasCenter + (row.get(s.name) ?? 0),
    },
    data: s,
  }));
}

/**
 * Validate a DAG for common issues.
 * Returns a list of error messages (empty = valid).
 */
export function validateDag(
  stages: { name: string; agent?: string | null; action?: string | null }[],
  edges: { from: string; to: string }[],
): string[] {
  const errors: string[] = [];
  const stageNames = new Set(stages.map((s) => s.name));

  // Check for duplicate stage names
  const seen = new Set<string>();
  for (const s of stages) {
    if (seen.has(s.name)) {
      errors.push(`Duplicate stage name: "${s.name}"`);
    }
    seen.add(s.name);
  }

  // Check edges reference valid stages
  for (const e of edges) {
    if (!stageNames.has(e.from)) {
      errors.push(`Edge references unknown source stage: "${e.from}"`);
    }
    if (!stageNames.has(e.to)) {
      errors.push(`Edge references unknown target stage: "${e.to}"`);
    }
  }

  // Check for stages with no agent or action
  for (const s of stages) {
    if (!s.agent && !s.action) {
      errors.push(`Stage "${s.name}" has no agent or action assigned`);
    }
  }

  // Check reachability: all non-root stages should be reachable from a root
  const roots = new Set(stageNames);
  for (const e of edges) {
    roots.delete(e.to);
  }
  if (roots.size === 0 && stages.length > 0) {
    errors.push("No root stages found -- every stage has incoming edges (possible cycle)");
  }

  const reachable = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const s of stages) adjacency.set(s.name, []);
  for (const e of edges) {
    if (adjacency.has(e.from)) {
      adjacency.get(e.from)!.push(e.to);
    }
  }

  function dfs(node: string) {
    if (reachable.has(node)) return;
    reachable.add(node);
    for (const neighbor of adjacency.get(node) || []) {
      dfs(neighbor);
    }
  }

  for (const root of roots) dfs(root);

  for (const s of stages) {
    if (!reachable.has(s.name)) {
      errors.push(`Stage "${s.name}" is unreachable from any root stage`);
    }
  }

  return errors;
}

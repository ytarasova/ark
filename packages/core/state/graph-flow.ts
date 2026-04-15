/**
 * Graph-based flow definitions — DAGs with conditional routing.
 * Extends the existing linear flow system with parallel branches,
 * conditional edges, and join barriers.
 */

export interface FlowNode {
  name: string;
  agent: string;
  model?: string;
  gate?: "auto" | "manual" | "review";
  on_failure?: string; // retry, skip, or node name to jump to
}

export interface FlowEdge {
  from: string;
  to: string;
  condition?: string; // JS expression evaluated against session data, e.g., "status === 'approved'"
  label?: string;
}

export interface GraphFlow {
  name: string;
  description?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  entrypoints?: string[]; // nodes with no incoming edges (auto-detected if not specified)
}

/** Parse a graph flow from YAML definition. */
export function parseGraphFlow(yaml: any): GraphFlow {
  const nodes: FlowNode[] = (yaml.nodes ?? yaml.stages ?? []).map((n: any) => ({
    name: n.name,
    agent: n.agent,
    model: n.model,
    gate: n.gate ?? "auto",
    on_failure: n.on_failure,
  }));

  const edges: FlowEdge[] = (yaml.edges ?? []).map((e: any) => ({
    from: e.from,
    to: e.to,
    condition: e.condition,
    label: e.label,
  }));

  // Auto-generate edges when no explicit edges provided
  if (edges.length === 0 && nodes.length > 1) {
    const rawStages = yaml.nodes ?? yaml.stages ?? [];
    const hasDependsOn = rawStages.some((s: any) => s.depends_on?.length > 0);

    if (hasDependsOn) {
      // Synthesize edges from depends_on declarations
      for (let i = 0; i < rawStages.length; i++) {
        const s = rawStages[i];
        if (s.depends_on?.length > 0) {
          for (const dep of s.depends_on) {
            edges.push({ from: dep, to: s.name });
          }
        } else if (i > 0) {
          // No depends_on: implicit linear dependency on previous stage
          edges.push({ from: rawStages[i - 1].name, to: s.name });
        }
      }
    } else {
      // Pure linear: no depends_on anywhere
      for (let i = 0; i < nodes.length - 1; i++) {
        edges.push({ from: nodes[i].name, to: nodes[i + 1].name });
      }
    }
  }

  // Auto-detect entrypoints
  const targets = new Set(edges.map((e) => e.to));
  const entrypoints = yaml.entrypoints ?? nodes.filter((n) => !targets.has(n.name)).map((n) => n.name);

  return { name: yaml.name, description: yaml.description, nodes, edges, entrypoints };
}

/**
 * Evaluate a condition expression against session data.
 * Conditions come from trusted flow YAML definitions (not user input).
 */
function evaluateCondition(condition: string, sessionData: Record<string, unknown>): boolean {
  try {
    // Note: conditions are from trusted flow YAML, not arbitrary user input
    const fn = new Function("session", `return ${condition}`);
    return fn(sessionData);
  } catch {
    return true;
  }
}

/** Get successor nodes for a given node. */
export function getSuccessors(flow: GraphFlow, nodeName: string, sessionData?: Record<string, unknown>): string[] {
  return flow.edges
    .filter((e) => {
      if (e.from !== nodeName) return false;
      if (!e.condition) return true;
      return evaluateCondition(e.condition, sessionData ?? {});
    })
    .map((e) => e.to);
}

/** Get predecessor nodes (for join detection). */
export function getPredecessors(flow: GraphFlow, nodeName: string): string[] {
  return flow.edges.filter((e) => e.to === nodeName).map((e) => e.from);
}

/** Check if a node is a join point (multiple incoming edges). */
export function isJoinNode(flow: GraphFlow, nodeName: string): boolean {
  return getPredecessors(flow, nodeName).length > 1;
}

/** Check if a node is a fan-out point (multiple outgoing edges). */
export function isFanOutNode(flow: GraphFlow, nodeName: string): boolean {
  return flow.edges.filter((e) => e.from === nodeName).length > 1;
}

/** Get all nodes in topological order. */
export function topologicalSort(flow: GraphFlow): string[] {
  const inDegree = new Map<string, number>();
  for (const node of flow.nodes) inDegree.set(node.name, 0);
  for (const edge of flow.edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([n]) => n);
  const result: string[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);
    for (const edge of flow.edges.filter((e) => e.from === node)) {
      const newDeg = (inDegree.get(edge.to) ?? 1) - 1;
      inDegree.set(edge.to, newDeg);
      if (newDeg === 0) queue.push(edge.to);
    }
  }

  return result;
}

/**
 * Resolve the next stages to execute from a given node, considering:
 * 1. Conditional edge evaluation against session data
 * 2. Default edges (no condition) as fallback when no conditional edges match
 * 3. Join barriers -- only return a successor if ALL its active predecessors are completed
 *
 * Returns an array of stage names that are ready to execute.
 * Empty array means: either no successors (terminal node) or join barriers not met.
 */
export function resolveNextStages(
  flow: GraphFlow,
  currentNode: string,
  sessionData: Record<string, unknown>,
  completedStages: string[],
  skippedStages: string[] = [],
): string[] {
  // The current node is completing -- include it in the completed set
  // so join barrier checks on successors see it as done
  const completed = new Set([...completedStages, currentNode]);
  const skipped = new Set(skippedStages);

  const outgoing = flow.edges.filter((e) => e.from === currentNode);
  if (outgoing.length === 0) return [];

  // Separate conditional and unconditional (default) edges
  const conditionalEdges = outgoing.filter((e) => e.condition);
  const defaultEdges = outgoing.filter((e) => !e.condition);

  let successorNames: string[];

  if (conditionalEdges.length > 0) {
    // Evaluate conditional edges
    const matched = conditionalEdges.filter((e) => evaluateCondition(e.condition!, sessionData)).map((e) => e.to);

    // If no conditional edges matched, use default edges as fallback
    successorNames = matched.length > 0 ? matched : defaultEdges.map((e) => e.to);
  } else {
    // No conditional edges -- use all default edges
    successorNames = defaultEdges.map((e) => e.to);
  }

  // Filter out already-completed or skipped stages
  successorNames = successorNames.filter((s) => !completed.has(s) && !skipped.has(s));

  // Check join barriers -- a successor is only ready if ALL its
  // active predecessors (not skipped) have completed
  return successorNames.filter((successor) => {
    const preds = getPredecessors(flow, successor);
    // Only wait for predecessors that are on the active path (not skipped)
    const activePreds = preds.filter((p) => !skipped.has(p));
    return activePreds.every((p) => completed.has(p));
  });
}

/**
 * Determine which stages should be marked as skipped when a conditional
 * branch is NOT taken. Given the chosen successors from a node, find
 * all nodes reachable ONLY through the unchosen edges and mark them skipped.
 */
export function computeSkippedStages(
  flow: GraphFlow,
  currentNode: string,
  chosenSuccessors: string[],
  existingSkipped: string[] = [],
): string[] {
  const chosen = new Set(chosenSuccessors);
  const outgoing = flow.edges.filter((e) => e.from === currentNode);
  const unchosenTargets = outgoing.map((e) => e.to).filter((t) => !chosen.has(t));

  // BFS from unchosen targets to find all exclusively-reachable nodes
  const reachableFromChosen = new Set<string>();
  const queue = [...chosenSuccessors];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (reachableFromChosen.has(node)) continue;
    reachableFromChosen.add(node);
    for (const e of flow.edges.filter((ed) => ed.from === node)) {
      queue.push(e.to);
    }
  }

  // Nodes reachable ONLY from unchosen paths (not also reachable from chosen paths)
  const skipped = new Set(existingSkipped);
  const unchosenQueue = [...unchosenTargets];
  const visited = new Set<string>();
  while (unchosenQueue.length > 0) {
    const node = unchosenQueue.shift()!;
    if (visited.has(node)) continue;
    visited.add(node);
    // Only skip if not reachable from the chosen path
    if (!reachableFromChosen.has(node)) {
      skipped.add(node);
      for (const e of flow.edges.filter((ed) => ed.from === node)) {
        unchosenQueue.push(e.to);
      }
    }
  }

  return [...skipped];
}

/** Validate a graph flow for cycles and missing nodes. */
export function validateGraphFlow(flow: GraphFlow): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const nodeNames = new Set(flow.nodes.map((n) => n.name));

  for (const edge of flow.edges) {
    if (!nodeNames.has(edge.from)) errors.push(`Edge references unknown node: ${edge.from}`);
    if (!nodeNames.has(edge.to)) errors.push(`Edge references unknown node: ${edge.to}`);
  }

  // Check for cycles via topological sort
  const sorted = topologicalSort(flow);
  if (sorted.length < flow.nodes.length) {
    errors.push("Flow contains a cycle");
  }

  if ((flow.entrypoints ?? []).length === 0) {
    errors.push("Flow has no entrypoints");
  }

  return { valid: errors.length === 0, errors };
}

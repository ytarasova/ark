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
  on_failure?: string;  // retry, skip, or node name to jump to
}

export interface FlowEdge {
  from: string;
  to: string;
  condition?: string;  // JS expression evaluated against session data, e.g., "status === 'approved'"
  label?: string;
}

export interface GraphFlow {
  name: string;
  description?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  entrypoints?: string[];  // nodes with no incoming edges (auto-detected if not specified)
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

  // Auto-generate edges from linear stages if no explicit edges
  if (edges.length === 0 && nodes.length > 1) {
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({ from: nodes[i].name, to: nodes[i + 1].name });
    }
  }

  // Auto-detect entrypoints
  const targets = new Set(edges.map(e => e.to));
  const entrypoints = yaml.entrypoints ?? nodes.filter(n => !targets.has(n.name)).map(n => n.name);

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
    .filter(e => {
      if (e.from !== nodeName) return false;
      if (!e.condition) return true;
      return evaluateCondition(e.condition, sessionData ?? {});
    })
    .map(e => e.to);
}

/** Get predecessor nodes (for join detection). */
export function getPredecessors(flow: GraphFlow, nodeName: string): string[] {
  return flow.edges.filter(e => e.to === nodeName).map(e => e.from);
}

/** Check if a node is a join point (multiple incoming edges). */
export function isJoinNode(flow: GraphFlow, nodeName: string): boolean {
  return getPredecessors(flow, nodeName).length > 1;
}

/** Check if a node is a fan-out point (multiple outgoing edges). */
export function isFanOutNode(flow: GraphFlow, nodeName: string): boolean {
  return flow.edges.filter(e => e.from === nodeName).length > 1;
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
    for (const edge of flow.edges.filter(e => e.from === node)) {
      const newDeg = (inDegree.get(edge.to) ?? 1) - 1;
      inDegree.set(edge.to, newDeg);
      if (newDeg === 0) queue.push(edge.to);
    }
  }

  return result;
}

/** Validate a graph flow for cycles and missing nodes. */
export function validateGraphFlow(flow: GraphFlow): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const nodeNames = new Set(flow.nodes.map(n => n.name));

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

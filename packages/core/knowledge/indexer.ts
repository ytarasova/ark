import { execFileSync } from "child_process";
import type { KnowledgeStore } from "./store.js";

export interface IndexResult {
  files: number;
  symbols: number;
  edges: number;
  duration_ms: number;
}

/** Injectable exec function type for testability. */
export type ExecFn = (cmd: string, args: string[], opts?: any) => string;

const defaultExec: ExecFn = (cmd, args, opts) =>
  execFileSync(cmd, args, opts) as unknown as string;

/**
 * Check if Axon CLI is installed.
 */
export function isAxonInstalled(exec: ExecFn = defaultExec): boolean {
  try {
    exec("axon", ["--version"], { stdio: "pipe" });
    return true;
  } catch { return false; /* not installed */ }
}

/**
 * Index a codebase using Axon + git co-change analysis.
 * Axon parses 33+ languages via tree-sitter, extracts files, symbols, dependencies.
 * Results are stored as nodes + edges in the knowledge store.
 */
export async function indexCodebase(
  repoPath: string,
  store: KnowledgeStore,
  opts?: { incremental?: boolean; changedFiles?: string[]; exec?: ExecFn },
): Promise<IndexResult> {
  const exec = opts?.exec ?? defaultExec;
  const start = Date.now();
  let files = 0, symbols = 0, edges = 0;

  // If incremental, only re-index changed files
  if (opts?.incremental && opts.changedFiles?.length) {
    for (const f of opts.changedFiles) {
      store.removeNode(`file:${f}`);
      // Remove symbol nodes for this file
      const symbolNodes = store.listNodes({ type: "symbol" }).filter(
        n => (n.metadata as any).file === f
      );
      for (const sn of symbolNodes) store.removeNode(sn.id);
    }
  } else if (!opts?.incremental) {
    // Full re-index: clear existing codebase nodes
    store.clear({ type: "file" });
    store.clear({ type: "symbol" });
  }

  // Call Axon
  try {
    const result = exec("axon", ["analyze", "--json", "--project-root", repoPath], {
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024, // 50MB for large repos
      timeout: 120_000, // 2 minutes
    });
    const graph = JSON.parse(result);

    // Map Axon nodes to our schema
    for (const node of graph.nodes ?? []) {
      if (node.type === "file" || node.type === "module") {
        store.addNode({
          id: `file:${node.path ?? node.id}`,
          type: "file",
          label: node.path ?? node.id,
          content: node.summary ?? null,
          metadata: { language: node.language, lines: node.lines, ...node.metadata },
        });
        files++;
      } else if (node.type === "function" || node.type === "class" || node.type === "symbol") {
        store.addNode({
          id: `symbol:${node.file ?? ""}::${node.name ?? node.id}`,
          type: "symbol",
          label: node.name ?? node.id,
          content: node.docstring ?? null,
          metadata: { kind: node.type, file: node.file, line_start: node.line_start, line_end: node.line_end, exported: node.exported },
        });
        symbols++;
      }
    }

    // Map Axon edges
    for (const edge of graph.edges ?? []) {
      const sourceId = edge.source_type === "file" ? `file:${edge.source}` : `symbol:${edge.source}`;
      const targetId = edge.target_type === "file" ? `file:${edge.target}` : `symbol:${edge.target}`;
      const relation = mapAxonRelation(edge.type ?? edge.relation ?? "depends_on");
      store.addEdge(sourceId, targetId, relation, edge.weight ?? 1.0);
      edges++;
    }
  } catch (e: any) {
    if (e.message?.includes("ENOENT") || e.message?.includes("not found")) {
      throw new Error("Axon is required for codebase indexing. Install: pip install axoniq");
    }
    throw e;
  }

  // Git co-change analysis
  edges += indexCoChanges(repoPath, store, { exec });

  return { files, symbols, edges, duration_ms: Date.now() - start };
}

function mapAxonRelation(type: string): "depends_on" | "imports" | "co_changes" {
  if (type === "imports" || type === "import") return "imports";
  if (type === "co_changes" || type === "co-change") return "co_changes";
  return "depends_on";
}

/**
 * Analyze git log for files that frequently change together.
 * Creates co_changes edges with weight = frequency / total_commits.
 */
export function indexCoChanges(repoPath: string, store: KnowledgeStore, opts?: { limit?: number; exec?: ExecFn }): number {
  const exec = opts?.exec ?? defaultExec;
  const limit = opts?.limit ?? 500;
  let edgeCount = 0;

  try {
    const log = exec("git", ["-C", repoPath, "log", "--format=%H", "--name-only", `-${limit}`], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Parse commits: empty line separates commits
    const commits: string[][] = [];
    let current: string[] = [];
    for (const line of log.split("\n")) {
      if (line.match(/^[0-9a-f]{40}$/)) {
        if (current.length > 0) commits.push(current);
        current = [];
      } else if (line.trim()) {
        current.push(line.trim());
      }
    }
    if (current.length > 0) commits.push(current);

    // Count co-occurrences
    const coChange = new Map<string, number>();
    for (const files of commits) {
      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const key = [files[i], files[j]].sort().join("|||");
          coChange.set(key, (coChange.get(key) ?? 0) + 1);
        }
      }
    }

    // Create edges for frequent co-changes (>= 3 times)
    for (const [key, count] of coChange) {
      if (count >= 3) {
        const [a, b] = key.split("|||");
        const weight = Math.min(count / commits.length, 1.0);
        store.addEdge(`file:${a}`, `file:${b}`, "co_changes", weight);
        edgeCount++;
      }
    }
  } catch { /* git log may fail in non-git repos */ }

  return edgeCount;
}

/**
 * After a session completes, create session node + modified_by edges.
 */
export function indexSessionCompletion(
  store: KnowledgeStore,
  sessionId: string,
  summary: string,
  outcome: string,
  changedFiles: string[],
): void {
  // Create/update session node
  const existing = store.getNode(`session:${sessionId}`);
  if (existing) {
    store.updateNode(`session:${sessionId}`, {
      metadata: { ...existing.metadata, outcome, files_changed: changedFiles },
    });
  } else {
    store.addNode({
      id: `session:${sessionId}`,
      type: "session",
      label: summary ?? sessionId,
      content: `Session ${sessionId}: ${summary}. Outcome: ${outcome}`,
      metadata: { outcome, files_changed: changedFiles },
    });
  }

  // Create modified_by edges
  for (const file of changedFiles) {
    store.addEdge(`file:${file}`, `session:${sessionId}`, "modified_by");
  }
}

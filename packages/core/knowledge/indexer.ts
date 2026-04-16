import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { Database } from "bun:sqlite";
import type { KnowledgeStore } from "./store.js";
import type { EdgeRelation } from "./types.js";

export interface IndexResult {
  files: number;
  symbols: number;
  edges: number;
  duration_ms: number;
}

/** Injectable exec function type for testability. */
export type ExecFn = (cmd: string, args: string[], opts?: any) => string;

const defaultExec: ExecFn = (cmd, args, opts) => execFileSync(cmd, args, opts) as unknown as string;

/**
 * Find the codegraph binary. Search order:
 * 1. node_modules/.bin/codegraph (local dev, after bun install)
 * 2. bin/codegraph next to the ark binary (vendored distribution)
 * 3. codegraph in PATH (global install)
 */
export function findCodegraphBinary(): string {
  // Local dev: node_modules/.bin
  const localBin = join(process.cwd(), "node_modules", ".bin", "codegraph");
  if (existsSync(localBin)) return localBin;

  // Vendored: next to ark binary
  const arkBin = process.argv[0];
  if (arkBin) {
    const vendored = join(dirname(arkBin), "codegraph");
    if (existsSync(vendored)) return vendored;
  }

  // Fall back to PATH
  return "codegraph";
}

/**
 * Check if the codegraph native engine is available.
 */
export function isCodegraphInstalled(): boolean {
  try {
    const bin = findCodegraphBinary();
    execFileSync(bin, ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Index a codebase using ops-codegraph (native Rust engine) + git co-change analysis.
 *
 * Flow:
 * 1. Run `codegraph build` to parse the codebase (33 languages, tree-sitter)
 * 2. Read the resulting .codegraph/graph.db with bun:sqlite
 * 3. Map nodes + edges into Ark's tenant-scoped KnowledgeStore
 * 4. Add git co-change edges on top
 */
export async function indexCodebase(
  repoPath: string,
  store: KnowledgeStore,
  opts?: { incremental?: boolean; changedFiles?: string[]; exec?: ExecFn },
): Promise<IndexResult> {
  const exec = opts?.exec ?? defaultExec;
  const start = Date.now();
  let files = 0,
    symbols = 0,
    edges = 0;

  // If incremental, only re-index changed files
  if (opts?.incremental && opts.changedFiles?.length) {
    for (const f of opts.changedFiles) {
      store.removeNode(`file:${f}`);
      const symbolNodes = store
        .listNodes({ type: "symbol" })
        .filter((n) => (n.metadata?.file as string | undefined) === f);
      for (const sn of symbolNodes) store.removeNode(sn.id);
    }
  } else if (!opts?.incremental) {
    // Full re-index: clear existing codebase nodes (preserve session/memory/learning nodes)
    store.clear({ type: "file" });
    store.clear({ type: "symbol" });
  }

  // Build graph with codegraph native engine
  const cgDir = join(repoPath, ".codegraph");
  const dbPath = join(cgDir, "graph.db");
  const codegraphBin = findCodegraphBinary();

  try {
    const buildArgs = ["build"];
    if (!opts?.incremental) buildArgs.push("--no-incremental");
    buildArgs.push(repoPath);
    exec(codegraphBin, buildArgs, {
      encoding: "utf-8",
      cwd: repoPath,
      timeout: 300_000, // 5 minutes for large repos
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e: any) {
    if (e.message?.includes("ENOENT") || e.message?.includes("not found")) {
      throw new Error("codegraph is required for codebase indexing. Install: bun add @optave/codegraph");
    }
    throw e;
  }

  // Read results from .codegraph/graph.db
  if (!existsSync(dbPath)) {
    throw new Error(`codegraph build did not produce ${dbPath}`);
  }

  // Note: can't use readonly mode -- ops-codegraph uses WAL, bun:sqlite fails to open -wal/-shm files in readonly
  const cgDb = new Database(dbPath);
  try {
    // Map codegraph nodes to Ark knowledge nodes
    const nodeRows = cgDb
      .query("SELECT id, kind, name, file, line, end_line, visibility, exported, qualified_name FROM nodes")
      .all() as CodegraphNode[];

    // Build ID lookup for edge mapping
    const nodeIdMap = new Map<number, { kind: string; name: string; file: string; line: number }>();

    // Track files we've already added (codegraph stores file as a column, not a separate node kind)
    const addedFiles = new Set<string>();

    for (const node of nodeRows) {
      nodeIdMap.set(node.id, { kind: node.kind, name: node.name, file: node.file, line: node.line });

      // Ensure the file node exists
      if (node.file && !addedFiles.has(node.file)) {
        store.addNode({
          id: `file:${node.file}`,
          type: "file",
          label: node.file,
          content: null,
          metadata: { language: detectLanguage(node.file) },
        });
        addedFiles.add(node.file);
        files++;
      }

      // Add symbol node
      const symbolId = `symbol:${node.file}::${node.name}:${node.line}`;
      store.addNode({
        id: symbolId,
        type: "symbol",
        label: node.name,
        content: null,
        metadata: {
          kind: node.kind,
          file: node.file,
          line_start: node.line,
          line_end: node.end_line,
          exported: node.exported === 1,
          visibility: node.visibility,
          qualified_name: node.qualified_name,
        },
      });
      symbols++;
    }

    // Map codegraph edges to Ark knowledge edges
    const edgeRows = cgDb.query("SELECT source_id, target_id, kind FROM edges").all() as CodegraphEdge[];

    for (const edge of edgeRows) {
      const src = nodeIdMap.get(edge.source_id);
      const tgt = nodeIdMap.get(edge.target_id);
      if (!src || !tgt) continue;

      const sourceId = `symbol:${src.file}::${src.name}:${src.line}`;
      const targetId = `symbol:${tgt.file}::${tgt.name}:${tgt.line}`;

      const relation = mapEdgeRelation(edge.kind);
      store.addEdge(sourceId, targetId, relation);
      edges++;
    }
  } finally {
    cgDb.close();
  }

  // Git co-change analysis (codegraph has this built-in, but we also store in Ark's graph)
  edges += indexCoChanges(repoPath, store, { exec });

  return { files, symbols, edges, duration_ms: Date.now() - start };
}

function mapEdgeRelation(kind: string): EdgeRelation {
  switch (kind) {
    case "imports":
    case "imports-type":
    case "dynamic-imports":
    case "reexports":
      return "imports";
    case "co_changes":
      return "co_changes";
    case "calls":
    case "extends":
    case "implements":
    case "contains":
    default:
      return "depends_on";
  }
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    rb: "ruby",
    php: "php",
    swift: "swift",
    dart: "dart",
    scala: "scala",
    ex: "elixir",
    erl: "erlang",
    hs: "haskell",
    ml: "ocaml",
    lua: "lua",
    zig: "zig",
    r: "r",
    sol: "solidity",
    v: "verilog",
    sh: "bash",
    bash: "bash",
  };
  return langMap[ext] ?? "unknown";
}

interface CodegraphNode {
  id: number;
  kind: string;
  name: string;
  file: string;
  line: number;
  end_line: number;
  visibility: string | null;
  exported: number;
  qualified_name: string | null;
}

interface CodegraphEdge {
  source_id: number;
  target_id: number;
  kind: string;
}

/**
 * Analyze git log for files that frequently change together.
 * Creates co_changes edges with weight = frequency / total_commits.
 */
export function indexCoChanges(
  repoPath: string,
  store: KnowledgeStore,
  opts?: { limit?: number; exec?: ExecFn },
): number {
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
  } catch {
    /* git log may fail in non-git repos */
  }

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

  for (const file of changedFiles) {
    store.addEdge(`file:${file}`, `session:${sessionId}`, "modified_by");
  }
}

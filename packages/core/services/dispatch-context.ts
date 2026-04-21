/**
 * Dispatch-time context injection -- remote codegraph ingest, knowledge graph
 * context, repo-map rendering. Pulled out of dispatch.ts to keep that file
 * focused on launch orchestration.
 */

import type { AppContext } from "../app.js";
import type { Session } from "../../types/index.js";
import { logDebug, logInfo } from "../observability/structured-log.js";
import { generateRepoMap, formatRepoMap } from "../repo-map.js";

/** Ingest nodes/edges from a remote arkd /codegraph/index response into the knowledge store. */
export async function ingestRemoteIndex(app: AppContext, data: any, log: (msg: string) => void): Promise<void> {
  const addedFiles = new Set<string>();
  for (const node of data.nodes ?? []) {
    if (node.file && !addedFiles.has(node.file)) {
      await app.knowledge.addNode({
        id: `file:${node.file}`,
        type: "file",
        label: node.file,
        metadata: { language: node.file.split(".").pop() ?? "unknown" },
      });
      addedFiles.add(node.file);
    }
    await app.knowledge.addNode({
      id: `symbol:${node.file}::${node.name}:${node.line}`,
      type: "symbol",
      label: node.name,
      metadata: {
        kind: node.kind,
        file: node.file,
        line_start: node.line,
        line_end: node.end_line,
        exported: node.exported === 1,
      },
    });
  }
  for (const edge of data.edges ?? []) {
    const srcNode = (data.nodes ?? []).find((n: any) => n.id === edge.source_id);
    const tgtNode = (data.nodes ?? []).find((n: any) => n.id === edge.target_id);
    if (srcNode && tgtNode) {
      await app.knowledge.addEdge(
        `symbol:${srcNode.file}::${srcNode.name}:${srcNode.line}`,
        `symbol:${tgtNode.file}::${tgtNode.name}:${tgtNode.line}`,
        edge.kind === "imports" ? "imports" : "depends_on",
      );
    }
  }
  log(`Remote index: ${addedFiles.size} files, ${(data.nodes ?? []).length} symbols`);
}

/**
 * Index the session's repo into the knowledge graph before dispatch.
 * For remote compute, always calls arkd /codegraph/index. For local compute,
 * runs the in-process indexer when autoIndex is enabled.
 */
export async function indexRepoForDispatch(
  app: AppContext,
  session: Session,
  log: (msg: string) => void,
): Promise<void> {
  if (!session.repo) return;

  const repoPath = session.workdir ?? session.repo;
  const compute = session.compute_name ? await app.computes.get(session.compute_name) : null;
  const computeIp = compute?.config?.ip as string | undefined;

  if (computeIp) {
    // Remote compute -- ALWAYS index via arkd (control plane needs centralized knowledge)
    const arkdPort = (compute?.config?.arkd_port as number | undefined) ?? 19300;
    const arkdUrl = `http://${computeIp}:${arkdPort}`;
    try {
      log("Indexing codebase on remote...");
      const resp = await fetch(`${arkdUrl}/codegraph/index`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath, incremental: true }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { ok?: boolean; files?: number; symbols?: number; error?: string };
        await ingestRemoteIndex(app, data, log);
      }
    } catch (e: any) {
      log(`Remote index failed: ${e.message}`);
    }
    return;
  }

  if (!app.config.knowledge?.autoIndex) return;

  try {
    const { indexCodebase } = await import("../knowledge/indexer.js");
    const existingFiles = await app.knowledge.listNodes({ type: "file", limit: 1 });
    if (existingFiles.length === 0) {
      log("Auto-indexing codebase...");
      await indexCodebase(repoPath, app.knowledge);
    } else if (app.config.knowledge.incrementalIndex) {
      log("Incremental index...");
      await indexCodebase(repoPath, app.knowledge, { incremental: true });
    }
  } catch (e: any) {
    log(`Auto-index skipped: ${e.message}`);
  }
}

/** Inject knowledge-graph context (memories, learnings, related sessions) above the task. */
export async function injectKnowledgeContext(app: AppContext, session: Session, task: string): Promise<string> {
  if (!app.knowledge) return task;
  try {
    const { buildContext, formatContextAsMarkdown } = await import("../knowledge/context.js");
    const ctx = await buildContext(app.knowledge, task, {
      repo: session.repo ?? undefined,
      sessionId: session.id,
    });
    const contextMd = formatContextAsMarkdown(ctx);
    if (contextMd) return contextMd + task;
  } catch {
    logInfo("session", "knowledge not available -- continue without context");
  }
  return task;
}

/** Append a compact repo-map tree to the task for codebase awareness. */
export function injectRepoMap(session: Session, task: string): string {
  if (!session.repo) return task;
  try {
    const repoMap = generateRepoMap(session.workdir ?? session.repo, { maxFiles: 200 });
    if (repoMap.entries.length > 0) {
      const mapStr = formatRepoMap(repoMap.entries, 1500);
      return task + `\n\n## Repository Structure\n\`\`\`\n${mapStr}\n\`\`\`\n`;
    }
  } catch {
    logDebug("session", "skip repo map on error");
  }
  return task;
}

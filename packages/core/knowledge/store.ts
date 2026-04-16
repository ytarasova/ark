import type { IDatabase } from "../database/index.js";
import type { KnowledgeNode, KnowledgeEdge, NodeType, EdgeRelation } from "./types.js";
import { randomUUID } from "crypto";

interface NodeRow {
  id: string;
  type: NodeType;
  label: string;
  content: string | null;
  metadata: string;
  tenant_id: string;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  source_id: string;
  target_id: string;
  relation: EdgeRelation;
  weight: number;
  metadata: string;
  tenant_id: string;
  created_at: string;
}

export class KnowledgeStore {
  private tenantId: string = "default";

  constructor(private db: IDatabase) {}

  setTenant(tenantId: string): void {
    this.tenantId = tenantId;
  }

  // --- Node CRUD ---
  addNode(opts: {
    id?: string;
    type: NodeType;
    label: string;
    content?: string;
    metadata?: Record<string, unknown>;
  }): string {
    const id = opts.id ?? `${opts.type}:${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT OR REPLACE INTO knowledge (id, type, label, content, metadata, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        opts.type,
        opts.label,
        opts.content ?? null,
        JSON.stringify(opts.metadata ?? {}),
        this.tenantId,
        now,
        now,
      );
    return id;
  }

  getNode(id: string): KnowledgeNode | null {
    const row = this.db.prepare("SELECT * FROM knowledge WHERE id = ? AND tenant_id = ?").get(id, this.tenantId) as
      | NodeRow
      | undefined;
    return row ? this.rowToNode(row) : null;
  }

  updateNode(id: string, fields: Partial<Pick<KnowledgeNode, "label" | "content" | "metadata">>): void {
    const sets: string[] = [];
    const params: any[] = [];
    if (fields.label !== undefined) {
      sets.push("label = ?");
      params.push(fields.label);
    }
    if (fields.content !== undefined) {
      sets.push("content = ?");
      params.push(fields.content);
    }
    if (fields.metadata !== undefined) {
      sets.push("metadata = ?");
      params.push(JSON.stringify(fields.metadata));
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id, this.tenantId);
    this.db.prepare(`UPDATE knowledge SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`).run(...params);
  }

  removeNode(id: string): void {
    this.db
      .prepare("DELETE FROM knowledge_edges WHERE (source_id = ? OR target_id = ?) AND tenant_id = ?")
      .run(id, id, this.tenantId);
    this.db.prepare("DELETE FROM knowledge WHERE id = ? AND tenant_id = ?").run(id, this.tenantId);
  }

  listNodes(opts?: { type?: NodeType; limit?: number }): KnowledgeNode[] {
    let sql = "SELECT * FROM knowledge WHERE tenant_id = ?";
    const params: unknown[] = [this.tenantId];
    if (opts?.type) {
      sql += " AND type = ?";
      params.push(opts.type);
    }
    sql += " ORDER BY updated_at DESC";
    if (opts?.limit) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    return (this.db.prepare(sql).all(...params) as NodeRow[]).map((r) => this.rowToNode(r));
  }

  // --- Edge CRUD ---
  addEdge(
    sourceId: string,
    targetId: string,
    relation: EdgeRelation,
    weight: number = 1.0,
    metadata?: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO knowledge_edges (source_id, target_id, relation, weight, metadata, tenant_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        sourceId,
        targetId,
        relation,
        weight,
        JSON.stringify(metadata ?? {}),
        this.tenantId,
        new Date().toISOString(),
      );
  }

  removeEdge(sourceId: string, targetId: string, relation?: EdgeRelation): void {
    if (relation) {
      this.db
        .prepare("DELETE FROM knowledge_edges WHERE source_id = ? AND target_id = ? AND relation = ? AND tenant_id = ?")
        .run(sourceId, targetId, relation, this.tenantId);
    } else {
      this.db
        .prepare("DELETE FROM knowledge_edges WHERE source_id = ? AND target_id = ? AND tenant_id = ?")
        .run(sourceId, targetId, this.tenantId);
    }
  }

  getEdges(nodeId: string, opts?: { relation?: EdgeRelation; direction?: "out" | "in" | "both" }): KnowledgeEdge[] {
    const dir = opts?.direction ?? "both";
    const parts: string[] = [];
    const params: unknown[] = [];
    if (dir === "out" || dir === "both") {
      parts.push("source_id = ?");
      params.push(nodeId);
    }
    if (dir === "in" || dir === "both") {
      parts.push("target_id = ?");
      params.push(nodeId);
    }
    let sql = `SELECT * FROM knowledge_edges WHERE (${parts.join(" OR ")}) AND tenant_id = ?`;
    params.push(this.tenantId);
    if (opts?.relation) {
      sql += " AND relation = ?";
      params.push(opts.relation);
    }
    return (this.db.prepare(sql).all(...params) as EdgeRow[]).map((r) => this.rowToEdge(r));
  }

  // --- Traversal ---
  neighbors(
    id: string,
    opts?: { relation?: EdgeRelation; direction?: "out" | "in" | "both"; maxDepth?: number; types?: NodeType[] },
  ): KnowledgeNode[] {
    const maxDepth = opts?.maxDepth ?? 2;
    const visited = new Set<string>([id]);
    let frontier = [id];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        const edges = this.getEdges(nodeId, { relation: opts?.relation, direction: opts?.direction });
        for (const edge of edges) {
          const neighborId = edge.source_id === nodeId ? edge.target_id : edge.source_id;
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            nextFrontier.push(neighborId);
          }
        }
      }
      frontier = nextFrontier;
    }

    visited.delete(id); // exclude the starting node
    const nodes: KnowledgeNode[] = [];
    for (const nid of visited) {
      const node = this.getNode(nid);
      if (node && (!opts?.types || opts.types.includes(node.type))) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  // --- Search ---
  search(query: string, opts?: { types?: NodeType[]; limit?: number }): Array<KnowledgeNode & { score: number }> {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2);
    if (words.length === 0) return [];

    let sql = "SELECT * FROM knowledge WHERE tenant_id = ?";
    const params: unknown[] = [this.tenantId];
    if (opts?.types?.length) {
      sql += ` AND type IN (${opts.types.map(() => "?").join(", ")})`;
      params.push(...opts.types);
    }
    // LIKE-based search (works for both SQLite and Postgres)
    const likeClauses = words.map(() => "(LOWER(label) LIKE ? OR LOWER(content) LIKE ?)");
    sql += ` AND (${likeClauses.join(" OR ")})`;
    for (const w of words) {
      params.push(`%${w}%`, `%${w}%`);
    }
    sql += ` LIMIT ?`;
    params.push(opts?.limit ?? 20);

    const rows = this.db.prepare(sql).all(...params) as NodeRow[];
    return rows
      .map((row) => {
        const node = this.rowToNode(row);
        // Simple scoring: count word matches
        const text = `${node.label} ${node.content ?? ""}`.toLowerCase();
        const score = words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0) / words.length;
        return { ...node, score };
      })
      .sort((a, b) => b.score - a.score);
  }

  // --- Bulk ---
  clear(opts?: { type?: NodeType }): void {
    if (opts?.type) {
      const ids = (
        this.db
          .prepare("SELECT id FROM knowledge WHERE type = ? AND tenant_id = ?")
          .all(opts.type, this.tenantId) as Array<{ id: string }>
      ).map((r) => r.id);
      for (const id of ids) this.removeNode(id);
    } else {
      this.db.prepare("DELETE FROM knowledge_edges WHERE tenant_id = ?").run(this.tenantId);
      this.db.prepare("DELETE FROM knowledge WHERE tenant_id = ?").run(this.tenantId);
    }
  }

  nodeCount(type?: NodeType): number {
    if (type) {
      return (
        this.db
          .prepare("SELECT COUNT(*) as c FROM knowledge WHERE type = ? AND tenant_id = ?")
          .get(type, this.tenantId) as { c: number }
      ).c;
    }
    return (
      this.db.prepare("SELECT COUNT(*) as c FROM knowledge WHERE tenant_id = ?").get(this.tenantId) as { c: number }
    ).c;
  }

  edgeCount(relation?: EdgeRelation): number {
    if (relation) {
      return (
        this.db
          .prepare("SELECT COUNT(*) as c FROM knowledge_edges WHERE relation = ? AND tenant_id = ?")
          .get(relation, this.tenantId) as { c: number }
      ).c;
    }
    return (
      this.db.prepare("SELECT COUNT(*) as c FROM knowledge_edges WHERE tenant_id = ?").get(this.tenantId) as {
        c: number;
      }
    ).c;
  }

  // --- Helpers ---
  private rowToNode(row: NodeRow): KnowledgeNode {
    return { ...row, metadata: JSON.parse(row.metadata || "{}") };
  }
  private rowToEdge(row: EdgeRow): KnowledgeEdge {
    return { ...row, metadata: JSON.parse(row.metadata || "{}") };
  }
}

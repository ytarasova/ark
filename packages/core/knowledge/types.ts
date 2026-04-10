export interface KnowledgeNode {
  id: string;
  type: NodeType;
  label: string;
  content: string | null;
  metadata: Record<string, unknown>;
  tenant_id: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeEdge {
  source_id: string;
  target_id: string;
  relation: EdgeRelation;
  weight: number;
  metadata: Record<string, unknown>;
  tenant_id: string;
  created_at: string;
}

export interface ContextPackage {
  files: Array<{
    path: string;
    language: string;
    dependents: number;
    recent_sessions: Array<{ id: string; summary: string; date: string }>;
  }>;
  memories: Array<{ content: string; importance: number; scope: string }>;
  sessions: Array<{ id: string; summary: string; outcome: string; files_changed: string[]; date: string }>;
  learnings: Array<{ title: string; description: string }>;
  skills: Array<{ name: string; description: string }>;
}

export type NodeType = "file" | "symbol" | "session" | "memory" | "learning" | "skill" | "recipe" | "agent";
export type EdgeRelation = "depends_on" | "imports" | "modified_by" | "learned_from" | "relates_to" | "uses" | "extracted_from" | "co_changes";

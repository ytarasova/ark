/**
 * Session artifact tracking types.
 *
 * Artifacts are discrete, queryable records of what a session produced:
 * files changed, commits made, PRs created, branches used.
 */

export type ArtifactType = "file" | "commit" | "pr" | "branch";

export interface SessionArtifact {
  id: number;
  session_id: string;
  type: ArtifactType;
  /** The artifact value: file path, commit hash, PR URL, or branch name. */
  value: string;
  /** Optional JSON metadata (e.g. commit message, file action). */
  metadata: Record<string, unknown>;
  tenant_id: string;
  created_at: string;
}

export interface ArtifactQuery {
  session_id?: string;
  type?: ArtifactType;
  value?: string;
  limit?: number;
}

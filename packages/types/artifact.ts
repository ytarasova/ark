/**
 * Artifact -- a tangible output produced during a session.
 *
 * Artifacts track commits, changed files, PRs, and branches created
 * by agents. Stored in the `artifacts` table for structured querying
 * instead of buried in the session config JSON blob.
 */

export type ArtifactType = "commit" | "file" | "pr" | "branch";

export interface Artifact {
  id: number;
  session_id: string;
  type: ArtifactType;
  /** The artifact value: commit hash, file path, PR URL, or branch name. */
  value: string;
  metadata: Record<string, unknown>;
  /** Flow stage that produced this artifact. */
  stage: string | null;
  tenant_id: string;
  created_at: string;
}

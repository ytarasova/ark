/**
 * Workspace port -- abstracts filesystem + git + PR operations for a session.
 *
 * Owner: workspace bounded context.
 *
 * Isolates the domain from direct `fs` / `child_process` / `git` calls. Today
 * `packages/core/services/workspace-service.ts` spawns shells and writes files
 * inline; every one of those operations becomes a method on this port.
 *
 * Local binding: `LocalWorkspace` (wraps existing free functions).
 * Control-plane binding: `ObjectStoreWorkspace` (S3/GCS file sync + remote clone).
 * Test binding: `InMemoryWorkspace` (no-op setup, returns a tmp path).
 */

import type { Session } from "../../types/index.js";

export interface WorkspaceSetupOpts {
  repo?: string | null;
  branch?: string | null;
  baseBranch?: string | null;
  cloneUrl?: string | null;
  onLog?: (msg: string) => void;
}

export interface WorkspaceSetupResult {
  /** Absolute path to the prepared workdir. */
  workdir: string;
  /** True if a worktree (as opposed to a fresh clone) was used. */
  worktree: boolean;
}

export interface CreatePROpts {
  title: string;
  body?: string;
  base?: string;
  draft?: boolean;
}

export interface CreatePRResult {
  prId: string;
  prUrl: string;
}

export interface CopyFilesOpts {
  /** Glob patterns (relative to `src`) to include. Defaults to all files. */
  globs?: string[];
}

export interface Workspace {
  /** Prepare a workdir for a session (clone, worktree, checkout). */
  setup(session: Session, opts?: WorkspaceSetupOpts): Promise<WorkspaceSetupResult>;

  /** Tear down the workdir for a session (remove worktree, delete clone). */
  teardown(session: Session): Promise<void>;

  /** Open a pull request for the session's branch. */
  createPR(session: Session, opts: CreatePROpts): Promise<CreatePRResult>;

  /** Merge a previously opened pull request. */
  mergePR(session: Session, prId: string): Promise<void>;

  /** Copy files from `src` to `dst` honouring the optional globs. */
  copyFiles(src: string, dst: string, opts?: CopyFilesOpts): Promise<void>;

  /** Safe basename-aware write of an attachment under a session's attachments dir. */
  writeAttachment(session: Session, name: string, bytes: Uint8Array | string): Promise<string>;
}

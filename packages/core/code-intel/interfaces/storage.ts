/**
 * RepoStorage -- where worktrees and per-run artifacts live.
 *
 * Local mode: a directory under `~/.ark/code-intel/`.
 * Control-plane mode: a per-tenant PVC mount (k8s) or an S3 prefix
 *   (serverless worker image). Extractors read/write via this interface
 *   so the physical backend is swappable.
 *
 * Extractors MUST NOT hard-code filesystem paths -- ask the storage
 * for a working-dir handle and let the impl decide where that lives.
 *
 * Example:
 *   const wd = await deployment.storage.workdirFor({ tenant_id, repo_id, run_id });
 *   await deployment.executor.run("git", ["ls-files"], { cwd: wd.absolutePath });
 */

export interface WorkdirHandle {
  /** Absolute path on local filesystem, or a remote URI the executor understands. */
  absolutePath: string;
  /** True when the backend is a local filesystem (fs APIs can be used directly). */
  isLocal: boolean;
  /** Release / clean up (caller is responsible for calling this). */
  release(): Promise<void>;
}

export interface WorkdirRequest {
  tenant_id: string;
  repo_id: string;
  run_id: string;
  /** Optional git branch hint -- the storage may clone/checkout that branch. */
  branch?: string;
}

export interface RepoStorage {
  /**
   * Provision a workdir for an indexing run. Implementations may clone the
   * repo lazily, bind-mount an existing worktree, or mount a remote PVC.
   */
  workdirFor(req: WorkdirRequest): Promise<WorkdirHandle>;

  /**
   * Persist an artifact produced by an extractor / run (JSON blobs, logs,
   * binary dumps). Returns a content-addressed identifier the store keeps
   * in `indexing_runs.extractor_counts.artifacts[name]` or similar.
   */
  writeArtifact(req: { run_id: string; name: string; data: Buffer | string }): Promise<{ id: string; uri: string }>;

  /** Read an artifact by id produced by `writeArtifact`. */
  readArtifact(id: string): Promise<Buffer>;
}

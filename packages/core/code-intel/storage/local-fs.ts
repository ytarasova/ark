/**
 * LocalRepoStorage -- filesystem-backed workdirs + artifact cache.
 *
 * Layout:
 *   <arkDir>/code-intel/workdirs/<run_id>/     <- workdir per run
 *   <arkDir>/code-intel/artifacts/<artifact_id> <- content-addressed blobs
 *
 * Workdirs are NOT clones; they're scratch directories. Extractors that
 * need a real git worktree either operate against an existing path
 * (passed via WorkdirRequest) or clone within the workdir themselves.
 * This keeps the storage API agnostic to git vs non-git backends.
 *
 * Control-plane mode swaps this out for a PVC- or S3-backed impl.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { createHash, randomUUID } from "crypto";
import type { RepoStorage, WorkdirHandle, WorkdirRequest } from "../interfaces/storage.js";

export class LocalRepoStorage implements RepoStorage {
  private readonly workdirsRoot: string;
  private readonly artifactsRoot: string;

  constructor(arkDir: string) {
    this.workdirsRoot = join(arkDir, "code-intel", "workdirs");
    this.artifactsRoot = join(arkDir, "code-intel", "artifacts");
    mkdirSync(this.workdirsRoot, { recursive: true });
    mkdirSync(this.artifactsRoot, { recursive: true });
  }

  async workdirFor(req: WorkdirRequest): Promise<WorkdirHandle> {
    const path = join(this.workdirsRoot, req.run_id);
    mkdirSync(path, { recursive: true });
    return {
      absolutePath: path,
      isLocal: true,
      release: async () => {
        if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      },
    };
  }

  async writeArtifact(req: {
    run_id: string;
    name: string;
    data: Buffer | string;
  }): Promise<{ id: string; uri: string }> {
    const buf = typeof req.data === "string" ? Buffer.from(req.data, "utf-8") : req.data;
    const hash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
    const id = `${req.run_id}-${req.name}-${hash}`;
    const path = join(this.artifactsRoot, id);
    writeFileSync(path, buf);
    return { id, uri: `file://${path}` };
  }

  async readArtifact(id: string): Promise<Buffer> {
    const path = join(this.artifactsRoot, id);
    if (!existsSync(path)) throw new Error(`artifact not found: ${id}`);
    return readFileSync(path);
  }
}

/** Used only when the caller wants an anonymous workdir (no tenant/run). */
export function ephemeralWorkdirId(): string {
  return `ephemeral-${randomUUID()}`;
}

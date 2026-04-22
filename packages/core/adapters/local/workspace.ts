/**
 * LocalWorkspace adapter -- stub.
 *
 * In Slice 1 this will wrap the existing free functions in
 * `services/worktree/` (setup.ts, git-ops.ts, pr.ts).
 */

import type {
  Workspace,
  WorkspaceSetupOpts,
  WorkspaceSetupResult,
  CreatePROpts,
  CreatePRResult,
  CopyFilesOpts,
} from "../../ports/workspace.js";
import type { Session } from "../../../types/index.js";

const NOT_MIGRATED = new Error("LocalWorkspace: not migrated yet -- Slice 1");

export class LocalWorkspace implements Workspace {
  async setup(_session: Session, _opts?: WorkspaceSetupOpts): Promise<WorkspaceSetupResult> {
    throw NOT_MIGRATED;
  }
  async teardown(_session: Session): Promise<void> {
    throw NOT_MIGRATED;
  }
  async createPR(_session: Session, _opts: CreatePROpts): Promise<CreatePRResult> {
    throw NOT_MIGRATED;
  }
  async mergePR(_session: Session, _prId: string): Promise<void> {
    throw NOT_MIGRATED;
  }
  async copyFiles(_src: string, _dst: string, _opts?: CopyFilesOpts): Promise<void> {
    throw NOT_MIGRATED;
  }
  async writeAttachment(_session: Session, _name: string, _bytes: Uint8Array | string): Promise<string> {
    throw NOT_MIGRATED;
  }
}

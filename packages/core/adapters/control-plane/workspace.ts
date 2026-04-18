/**
 * ObjectStoreWorkspace adapter -- stub.
 *
 * Hosted workspace that syncs files to/from object storage (S3/GCS) and
 * replaces git worktrees with clone-on-demand. Slice 1 migration.
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

const NOT_MIGRATED = new Error("ObjectStoreWorkspace: not migrated yet -- Slice 1");

export class ObjectStoreWorkspace implements Workspace {
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

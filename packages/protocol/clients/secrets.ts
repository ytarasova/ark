/**
 * SecretsClient -- secret / secret-blob RPCs.
 *
 * Carries the blob-secret half of the agent-F block. The tenant-auth
 * binding half lives on `AdminClient` because it sits under
 * `admin/tenant/auth/*`.
 */

import type { RpcFn } from "./rpc.js";

export class SecretsClient {
  readonly rpc!: RpcFn;
  constructor(rpc?: RpcFn) {
    if (rpc) this.rpc = rpc;
  }

  async secretList(): Promise<
    Array<{
      tenant_id: string;
      name: string;
      description?: string | null;
      created_at?: string | null;
      updated_at?: string | null;
    }>
  > {
    const { secrets } = await this.rpc<{ secrets: any[] }>("secret/list");
    return secrets;
  }

  async secretGet(name: string): Promise<string | null> {
    const { value } = await this.rpc<{ value: string | null }>("secret/get", { name });
    return value;
  }

  async secretSet(name: string, value: string, description?: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("secret/set", { name, value, description });
    return ok;
  }

  async secretDelete(name: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("secret/delete", { name });
    return ok;
  }

  // --- BEGIN agent-F: blob secrets half ---

  /** List blob-secret names for the current tenant. Never returns contents. */
  async secretBlobList(): Promise<string[]> {
    const { blobs } = await this.rpc<{ blobs: string[] }>("secret/blob/list");
    return blobs;
  }

  /**
   * Fetch every file in a blob. Files are returned base64-encoded so the
   * wire format is binary-safe; callers decode locally when writing to disk.
   */
  async secretBlobGet(name: string): Promise<{ files: Record<string, string>; encoding: "base64" } | null> {
    const { blob } = await this.rpc<{
      blob: { files: Record<string, string>; encoding: "base64" } | null;
    }>("secret/blob/get", { name });
    return blob;
  }

  /**
   * Create-or-replace a blob. Files default to base64-encoded values; pass
   * `encoding: "utf-8"` to let the server TextEncoder them server-side
   * (convenient for tests dealing with plaintext payloads).
   */
  async secretBlobSet(
    name: string,
    files: Record<string, string>,
    opts?: { encoding?: "base64" | "utf-8" },
  ): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("secret/blob/set", {
      name,
      files,
      encoding: opts?.encoding ?? "base64",
    });
    return ok;
  }

  /** Delete a blob. Returns true when a blob was actually removed. */
  async secretBlobDelete(name: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("secret/blob/delete", { name });
    return ok;
  }

  // --- END agent-F ---
}

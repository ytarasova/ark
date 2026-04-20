/**
 * LocalDiskBlobStore -- filesystem-backed BlobStore.
 *
 * Layout: `{root}/{tenantId}/{namespace}/{id}/{filename}`.
 *
 * When no tenant is available (single-tenant local-mode path), callers
 * should pass `LOCAL_TENANT_ID` (`"_local"`). That keeps the on-disk
 * layout stable even as we add tenant segregation in hosted mode.
 */

import { dirname, resolve, relative } from "path";
import { mkdir, writeFile, readFile, stat, rm, readdir, rmdir } from "fs/promises";
import {
  type BlobStore,
  type BlobKey,
  type BlobMeta,
  type PutOptions,
  DEFAULT_MAX_BYTES,
  encodeLocator,
  assertTenantMatch,
} from "./blob-store.js";

export class LocalDiskBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  async put(key: BlobKey, bytes: Buffer, opts: PutOptions = {}): Promise<BlobMeta> {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    if (bytes.length > maxBytes) {
      throw new Error(`Blob exceeds maxBytes (${bytes.length} > ${maxBytes})`);
    }
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const st = await stat(path);
    return {
      locator: encodeLocator(key),
      filename: key.filename,
      size: st.size,
      contentType: opts.contentType,
      createdAt: st.birthtime.toISOString(),
    };
  }

  async get(locator: string, requestingTenantId: string): Promise<{ bytes: Buffer; meta: BlobMeta }> {
    const key = assertTenantMatch(locator, requestingTenantId);
    const path = this.pathFor(key);
    const bytes = await readFile(path);
    const st = await stat(path);
    return {
      bytes,
      meta: {
        locator,
        filename: key.filename,
        size: st.size,
        createdAt: st.birthtime.toISOString(),
      },
    };
  }

  async delete(locator: string, requestingTenantId: string): Promise<void> {
    const key = assertTenantMatch(locator, requestingTenantId);
    const path = this.pathFor(key);
    await rm(path, { force: true });
    // Best-effort: drop the per-blob dir and any empty ancestors up to the
    // tenant dir so the tree doesn't accumulate dead entries.
    const tenantRoot = resolve(this.root, key.tenantId);
    let current = dirname(path);
    while (current !== tenantRoot && current.startsWith(tenantRoot)) {
      try {
        const entries = await readdir(current);
        if (entries.length > 0) break;
        await rmdir(current);
      } catch {
        break;
      }
      current = dirname(current);
    }
  }

  private pathFor(key: BlobKey): string {
    const candidate = resolve(this.root, key.tenantId, key.namespace, key.id, key.filename);
    // Defense in depth against path traversal: if any component resolved out
    // of the root, refuse to touch it.
    const rel = relative(resolve(this.root), candidate);
    if (rel.startsWith("..") || rel === "") {
      throw new Error("Blob path escapes storage root");
    }
    return candidate;
  }
}

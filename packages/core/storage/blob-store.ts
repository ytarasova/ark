/**
 * BlobStore -- opaque byte storage backing session input uploads (and,
 * in future, exports / snapshots that need off-node persistence).
 *
 * A BlobStore is addressed by a `BlobKey` tuple (tenant, namespace, id,
 * filename). `put()` returns a `BlobMeta` whose `locator` is an opaque
 * token the caller hands back to `get()` / `delete()`. The store is
 * responsible for parsing that locator and enforcing that the requesting
 * tenant matches the tenant baked into it -- this is the single line of
 * defense between tenants in hosted mode.
 *
 * Two backends ship:
 *   - LocalDiskBlobStore (default in `local` profile): mirrors the
 *     previous `arkDir/inputs/<id>/<name>` layout so the single-tenant
 *     developer install keeps behaving like a plain filesystem.
 *   - S3BlobStore (default in `control-plane` profile): writes to a
 *     configurable S3 bucket under `{prefix}/{tenantId}/{namespace}/...`,
 *     credentials resolved via the SDK default chain.
 */

export interface BlobKey {
  /** Tenant that owns the blob. Enforced on put/get/delete. */
  tenantId: string;
  /** Logical grouping within the tenant, e.g. "inputs", "exports". */
  namespace: string;
  /** Opaque per-blob id. Implementations derive a storage key from this. */
  id: string;
  /** Original filename, used for Content-Disposition + UX display. */
  filename: string;
}

export interface PutOptions {
  contentType?: string;
  /** Max bytes -- implementations should reject larger payloads. Default 50 MiB. */
  maxBytes?: number;
}

export interface BlobMeta {
  /** Stable identifier returned to clients in place of a filesystem path. */
  locator: string;
  filename: string;
  size: number;
  contentType?: string;
  createdAt: string;
}

export interface BlobStore {
  put(key: BlobKey, bytes: Buffer, opts?: PutOptions): Promise<BlobMeta>;
  get(locator: string, requestingTenantId: string): Promise<{ bytes: Buffer; meta: BlobMeta }>;
  delete(locator: string, requestingTenantId: string): Promise<void>;
  dispose?(): Promise<void>;
}

/** Default maximum upload size enforced by every backend. */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/** Fallback tenant id for the single-tenant local-mode path. */
export const LOCAL_TENANT_ID = "_local";

// ── Locator encoding ────────────────────────────────────────────────────────
//
// A locator is the base64url encoding of `<tenantId>/<namespace>/<id>/<filename>`.
// The store parses it to recover the tuple, so callers must treat it as
// opaque: any change to the encoding will invalidate existing locators, and
// the only supported shape today is this single one.

const SEP = "/";

/** Encode a BlobKey into an opaque locator. */
export function encodeLocator(key: BlobKey): string {
  const raw = [key.tenantId, key.namespace, key.id, key.filename].join(SEP);
  return Buffer.from(raw, "utf-8").toString("base64url");
}

/** Decode a locator back to its BlobKey. Throws on malformed input. */
export function decodeLocator(locator: string): BlobKey {
  let raw: string;
  try {
    raw = Buffer.from(locator, "base64url").toString("utf-8");
  } catch {
    throw new Error(`Invalid blob locator: ${locator}`);
  }
  const parts = raw.split(SEP);
  if (parts.length < 4) {
    throw new Error(`Invalid blob locator: ${locator}`);
  }
  // filename may contain "/" if a caller ever stuffs one in; reattach.
  const [tenantId, namespace, id, ...rest] = parts;
  const filename = rest.join(SEP);
  if (!tenantId || !namespace || !id || !filename) {
    throw new Error(`Invalid blob locator: ${locator}`);
  }
  return { tenantId, namespace, id, filename };
}

/**
 * Throw if the locator's tenant does not match the caller's tenant. Every
 * backend's `get()` + `delete()` MUST call this before touching storage.
 */
export function assertTenantMatch(locator: string, requestingTenantId: string): BlobKey {
  const key = decodeLocator(locator);
  if (key.tenantId !== requestingTenantId) {
    throw new Error("Blob access denied: tenant mismatch");
  }
  return key;
}

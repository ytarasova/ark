/**
 * Secrets backend -- tenant-scoped secret storage.
 *
 * Two providers implement this interface:
 *
 *  - `FileSecretsProvider` (local mode): encrypted file at
 *    `${arkDir}/secrets.json`.
 *  - `AwsSecretsProvider` (control plane): AWS SSM Parameter Store
 *    (`SecureString`) under `/ark/<tenant>/<NAME>`.
 *
 * The interface never leaks the underlying store: callers receive
 * `SecretRef` (metadata) from `list`, plain-text values only from `get`
 * and `resolveMany`. Name format is restricted to ASCII
 * `[A-Z0-9_]+` so it maps cleanly to shell env var names inside
 * dispatched agent sessions.
 */

/**
 * Discriminated union of all v1 secret types. Used by placement code to
 * know how to land a secret on a compute target (e.g. ssh keys go to
 * ~/.ssh, kubeconfigs to ~/.kube, env-vars are injected into the shell
 * environment, generic-blobs are written verbatim).
 */
export type SecretType = "env-var" | "ssh-private-key" | "generic-blob" | "kubeconfig";

export interface SecretRef {
  tenant_id: string;
  /** User-visible identifier, e.g. "ANTHROPIC_API_KEY". ASCII `[A-Z0-9_]+`. */
  name: string;
  /** How the secret is used/placed on a compute target. */
  type: SecretType;
  /** Arbitrary per-type key-value metadata (e.g. target path, permissions). */
  metadata: Record<string, string>;
  description?: string;
  created_at: string;
  updated_at: string;
}

export interface BlobRef {
  tenant_id: string;
  name: string;
  type: SecretType;
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface SecretsCapability {
  /** List secret refs (never values) for the tenant. */
  list(tenantId: string): Promise<SecretRef[]>;

  /** Fetch a single secret value. Returns null when the secret doesn't exist. */
  get(tenantId: string, name: string): Promise<string | null>;

  /** Create-or-replace. Caller is responsible for auth / audit. */
  set(
    tenantId: string,
    name: string,
    value: string,
    opts?: { description?: string; type?: SecretType; metadata?: Record<string, string> },
  ): Promise<void>;

  /** Delete. Returns true when a secret was actually removed. */
  delete(tenantId: string, name: string): Promise<boolean>;

  /**
   * Resolve a batch at dispatch time. Unknown names throw -- callers must
   * either declare the list they need or handle nulls via `get` themselves.
   */
  resolveMany(tenantId: string, names: string[]): Promise<Record<string, string>>;

  // ── Blob (multi-file) secrets ───────────────────────────────────────────
  // A "blob" is a named bag of files (filename -> bytes), stored atomically
  // under a single blob name. Used for the claude subscription credentials
  // where `~/.claude/` is actually multiple files (`.credentials.json`,
  // `.claude.json`). Distinct namespace from the string-valued secret API
  // above; the same blob name may coexist with a string secret of the same
  // name (they're keyed separately in every backend).

  /** List blob names (never contents) for the tenant. Sorted ASCII. */
  listBlobs(tenantId: string): Promise<string[]>;

  /** List blob refs (name + type + metadata, never contents) for the tenant. */
  listBlobsDetailed(tenantId: string): Promise<BlobRef[]>;

  /**
   * Fetch every file in a blob. Returns null when the blob doesn't exist.
   * File values are Uint8Array (binary-safe).
   */
  getBlob(tenantId: string, name: string): Promise<Record<string, Uint8Array> | null>;

  /**
   * Create-or-replace a blob. `files` may be strings (utf-8 encoded for you)
   * or Uint8Array. Caller is responsible for auth / audit.
   *
   * Contract: this is atomic-ish per-file. Backends that can't atomically
   * replace a multi-file blob (AWS SSM) delete-then-write; a crash in the
   * middle may leave a partial blob. Callers that need strict atomicity
   * should use a single string secret instead.
   */
  setBlob(
    tenantId: string,
    name: string,
    files: Record<string, Uint8Array | string>,
    opts?: { type?: SecretType; metadata?: Record<string, string> },
  ): Promise<void>;

  /** Delete a blob. Returns true when a blob was actually removed. */
  deleteBlob(tenantId: string, name: string): Promise<boolean>;
}

/**
 * Regex for valid secret names. ASCII upper-case letters, digits, and
 * underscore. These map directly to env var names inside the dispatched
 * session so the constraint is both shell-safe and conventional.
 */
export const SECRET_NAME_RE = /^[A-Z0-9_]+$/;

export function assertValidSecretName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Secret name must be a non-empty string");
  }
  if (!SECRET_NAME_RE.test(name)) {
    throw new Error(`Invalid secret name '${name}': must match [A-Z0-9_]+ (uppercase ASCII, digits, underscore)`);
  }
}

/**
 * Regex for valid blob names. Lower-case kebab-case so blobs are visually
 * distinct from string secrets in listings (e.g. `claude-subscription` vs
 * `ANTHROPIC_API_KEY`) and safe to use as path components + k8s Secret
 * names. Kept at 1..63 chars so the blob name fits inside a k8s label value
 * even after prefixing.
 */
export const BLOB_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function assertValidBlobName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Blob name must be a non-empty string");
  }
  if (!BLOB_NAME_RE.test(name)) {
    throw new Error(
      `Invalid blob name '${name}': must match [a-z0-9][a-z0-9-]{0,62} (lowercase kebab-case, <= 63 chars)`,
    );
  }
}

/**
 * Regex for a valid filename inside a blob. Restricts to printable ASCII
 * minus path / control characters so no backend has to think about
 * traversal, CR/LF, or NUL injection. Leading-dot files (`.credentials.json`)
 * are allowed -- that's the whole point of this feature.
 */
export const BLOB_FILE_RE = /^[A-Za-z0-9._-][A-Za-z0-9._-]{0,255}$/;

export function assertValidBlobFilename(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Blob filename must be a non-empty string");
  }
  if (name === "." || name === "..") {
    throw new Error(`Invalid blob filename '${name}': must not be '.' or '..'`);
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new Error(`Invalid blob filename '${name}': must not contain path separators`);
  }
  if (!BLOB_FILE_RE.test(name)) {
    throw new Error(`Invalid blob filename '${name}': only ASCII letters, digits, '.', '-', '_' are allowed`);
  }
}

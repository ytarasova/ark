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

export interface SecretRef {
  tenant_id: string;
  /** User-visible identifier, e.g. "ANTHROPIC_API_KEY". ASCII `[A-Z0-9_]+`. */
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

export interface SecretsCapability {
  /** List secret refs (never values) for the tenant. */
  list(tenantId: string): Promise<SecretRef[]>;

  /** Fetch a single secret value. Returns null when the secret doesn't exist. */
  get(tenantId: string, name: string): Promise<string | null>;

  /** Create-or-replace. Caller is responsible for auth / audit. */
  set(tenantId: string, name: string, value: string, opts?: { description?: string }): Promise<void>;

  /** Delete. Returns true when a secret was actually removed. */
  delete(tenantId: string, name: string): Promise<boolean>;

  /**
   * Resolve a batch at dispatch time. Unknown names throw -- callers must
   * either declare the list they need or handle nulls via `get` themselves.
   */
  resolveMany(tenantId: string, names: string[]): Promise<Record<string, string>>;
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

/**
 * SecretStore port -- abstracts retrieval of secrets.
 *
 * Replaces direct `process.env` reads scattered through `app.ts` and
 * `compute/providers/*`. The adapter decides whether a secret is loaded from
 * env, Vault, AWS Secrets Manager, etc.
 *
 * Local binding: `EnvSecretStore` (reads `process.env`).
 * Control-plane binding: `VaultSecretStore` (stub).
 * Test binding: `MapSecretStore` (in-memory map with seeded values).
 */

export interface SecretStore {
  /** Return a secret value or null if not set. Never throws. */
  get(key: string): string | null;

  /**
   * Return a secret value or throw a descriptive error if missing. Prefer
   * this at startup when a secret is required for the process to function.
   */
  require(key: string): string;

  /** Return true if the secret is set (may have empty string value). */
  has(key: string): boolean;
}

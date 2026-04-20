/**
 * Per-source / per-tenant signing secrets for trigger webhooks.
 *
 * Resolution order (highest first):
 *   1. `~/.ark/secrets.yaml` (gitignored) under
 *      `triggers.<source>.<tenant>.signing_key`
 *   2. `~/.ark/secrets.yaml` under `triggers.<source>.signing_key`
 *      (tenant-agnostic fallback)
 *   3. `ARK_TRIGGER_<SOURCE>_SECRET` env var (uppercased, dash -> underscore)
 *
 * Returns null when no secret is configured. Callers must refuse to verify
 * the request in that case -- there is no insecure default.
 *
 * File format (YAML):
 *   triggers:
 *     github:
 *       signing_key: "whsec_..."        # tenant-agnostic
 *       default:
 *         signing_key: "whsec_..."      # per-tenant
 *     slack:
 *       signing_key: "slk_..."
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";

interface SecretsFile {
  triggers?: Record<string, unknown>;
}

/** Load secrets from `<arkDir>/secrets.yaml`. Returns `{}` if the file is absent. */
export function loadSecretsFile(arkDir: string): SecretsFile {
  const path = join(arkDir, "secrets.yaml");
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    return (parseYaml(raw) ?? {}) as SecretsFile;
  } catch (e: any) {
    console.error(`[triggers/secrets] failed to parse ${path}: ${e?.message ?? e}`);
    return {};
  }
}

/**
 * Resolve the signing secret for a `(source, tenant)` pair.
 *
 * Env var form: `ARK_TRIGGER_<SOURCE>_SECRET` where `<SOURCE>` is the
 * source name uppercased with `-` replaced by `_`.
 */
export function resolveSecret(arkDir: string, source: string, tenant = "default"): string | null {
  const file = loadSecretsFile(arkDir);
  const bySource = file.triggers?.[source] as Record<string, unknown> | undefined;
  if (bySource) {
    const byTenant = bySource[tenant] as Record<string, unknown> | undefined;
    const tenantKey = byTenant?.signing_key;
    if (typeof tenantKey === "string" && tenantKey.length > 0) return tenantKey;
    const fallbackKey = bySource.signing_key;
    if (typeof fallbackKey === "string" && fallbackKey.length > 0) return fallbackKey;
  }
  const envName = secretEnvVar(source);
  const envVal = process.env[envName];
  if (envVal && envVal.length > 0) return envVal;
  return null;
}

/** Canonical env var name for a source. Exported for source-level `secretEnvVar`. */
export function secretEnvVar(source: string): string {
  return `ARK_TRIGGER_${source.toUpperCase().replace(/-/g, "_")}_SECRET`;
}

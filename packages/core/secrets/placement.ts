/**
 * Central dispatch for typed-secret placement.
 *
 * Loads every secret (string + blob) for the session's tenant, applies an
 * optional narrowing filter, and routes each ref through the placer
 * registered for its `type`. Per-type failure policy:
 *
 *  - Types in FAIL_FAST throw on any placer error (env-var / ssh-private-key
 *    / kubeconfig: missing them silently breaks the agent in subtle ways).
 *  - All other types (generic-blob in Phase 3) log a warning and continue.
 *
 * Unknown types (no registered placer) are skipped at debug level. This
 * allows older clusters to surface forward-incompatible types without
 * blowing up dispatch.
 */

import type { AppContext } from "../app.js";
import type { Session } from "../../types/index.js";
import type { PlacementCtx, TypedSecret, TypedSecretPlacer } from "./placement-types.js";
import { envVarPlacer } from "./placers/env-var.js";
import { sshPrivateKeyPlacer } from "./placers/ssh-private-key.js";
import { logInfo, logWarn, logDebug } from "../observability/structured-log.js";

const PLACERS: Record<string, TypedSecretPlacer> = {
  "env-var": envVarPlacer,
  "ssh-private-key": sshPrivateKeyPlacer,
  // generic-blob, kubeconfig registered in Phase 3
};

/** Per-type failure policy. Mutable at runtime so tests can register stubs. */
const FAIL_FAST = new Set<string>(["env-var", "ssh-private-key", "kubeconfig"]);

export interface PlaceAllSecretsOpts {
  /** When set, only these secret names are eligible. */
  narrow?: ReadonlySet<string>;
}

export async function placeAllSecrets(
  app: AppContext,
  session: Session,
  ctx: PlacementCtx,
  opts: PlaceAllSecretsOpts = {},
): Promise<void> {
  const tenantId = session.tenant_id ?? app.config.authSection.defaultTenant ?? "default";

  const stringRefs = await app.secrets.list(tenantId);
  const blobRefs = await app.secrets.listBlobsDetailed(tenantId);

  const eligible = <T extends { name: string }>(refs: T[]): T[] =>
    opts.narrow ? refs.filter((r) => opts.narrow!.has(r.name)) : refs;

  const stringSelected = eligible(stringRefs);
  const blobSelected = eligible(blobRefs);

  const stringValues = stringSelected.length
    ? await app.secrets.resolveMany(
        tenantId,
        stringSelected.map((r) => r.name),
      )
    : {};

  for (const ref of stringSelected) {
    const placer = PLACERS[ref.type];
    if (!placer) {
      logDebug("general", `secret_skipped: unknown_type type=${ref.type} name=${ref.name}`);
      continue;
    }
    const secret: TypedSecret = {
      name: ref.name,
      type: ref.type,
      metadata: ref.metadata,
      value: stringValues[ref.name],
    };
    try {
      await placer.place(secret, ctx);
      logInfo("general", `secret_placed name=${ref.name} type=${ref.type} session=${session.id}`);
    } catch (e: any) {
      const msg = `secret_placement_failed name=${ref.name} type=${ref.type}: ${e?.message ?? e}`;
      if (FAIL_FAST.has(ref.type)) throw new Error(msg);
      logWarn("general", msg);
    }
  }

  for (const ref of blobSelected) {
    const placer = PLACERS[ref.type];
    if (!placer) {
      logDebug("general", `secret_skipped: unknown_type type=${ref.type} name=${ref.name}`);
      continue;
    }
    const files = await app.secrets.getBlob(tenantId, ref.name);
    if (!files) {
      logWarn("general", `blob_disappeared name=${ref.name}`);
      continue;
    }
    const secret: TypedSecret = {
      name: ref.name,
      type: ref.type,
      metadata: ref.metadata,
      files,
    };
    try {
      await placer.place(secret, ctx);
      logInfo("general", `secret_placed name=${ref.name} type=${ref.type} session=${session.id}`);
    } catch (e: any) {
      const msg = `secret_placement_failed name=${ref.name} type=${ref.type}: ${e?.message ?? e}`;
      if (FAIL_FAST.has(ref.type)) throw new Error(msg);
      logWarn("general", msg);
    }
  }
}

/** @internal -- exported for tests so they can inject stub placers. */
export function __test_registerPlacer(type: string, placer: TypedSecretPlacer): void {
  PLACERS[type] = placer;
}

/** @internal -- exported for tests so they can mark a stub placer as fail-fast. */
export function __test_addFailFast(type: string): void {
  FAIL_FAST.add(type);
}

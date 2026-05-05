/**
 * Stage + runtime secret resolution.
 *
 * Precedence (first wins):
 *   1. Stage `secrets: [NAMES]`   -- operator-most-specific, wins.
 *   2. Runtime `secrets: [NAMES]` -- default for every session on that runtime.
 *
 * A missing secret is surfaced as a dispatch failure (`error` populated). We
 * never silently drop an env var the agent depends on.
 */

import { logWarn } from "../../observability/structured-log.js";
import type { DispatchDeps } from "./types.js";
import type { Session } from "../../../types/index.js";
import type { StageDefinition } from "../flow.js";

export class StageSecretResolver {
  constructor(private readonly deps: Pick<DispatchDeps, "runtimes" | "secrets" | "config">) {}

  async resolve(
    session: Session,
    stageDef: StageDefinition | null,
    runtimeKind: string,
    log: (msg: string) => void,
  ): Promise<{ env: Record<string, string>; error?: string }> {
    const names = new Set<string>();
    const stageList = Array.isArray(stageDef?.secrets) ? stageDef.secrets : [];
    for (const n of stageList) names.add(n);

    // Runtime-declared secrets. Avoid hard-failing if the runtime isn't
    // known (legacy executor paths may dispatch without a RuntimeStore row).
    try {
      const rt = this.deps.runtimes?.get?.(runtimeKind) ?? null;
      if (!rt) {
        logWarn("session", `secrets-resolve: runtime '${runtimeKind}' not found in store`);
      }
      const rtSecrets = Array.isArray(rt?.secrets) ? (rt as { secrets?: string[] }).secrets! : [];
      for (const n of rtSecrets) names.add(n);
    } catch (err: any) {
      logWarn("session", `secrets-resolve: runtime '${runtimeKind}' lookup failed: ${err?.message ?? err}`);
    }

    if (names.size === 0) return { env: {} };

    const tenantId = session.tenant_id ?? this.deps.config.authSection?.defaultTenant ?? "default";
    try {
      const env = await this.deps.secrets.resolveMany(tenantId, Array.from(names));
      log(`Resolved ${Object.keys(env).length} secret env var(s) for tenant ${tenantId}`);
      return { env };
    } catch (err: any) {
      return { env: {}, error: `Secret resolution failed: ${err?.message ?? String(err)}` };
    }
  }
}

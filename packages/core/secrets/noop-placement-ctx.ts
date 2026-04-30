import type { PlacementCtx } from "./placement-types.js";
import { logDebug } from "../observability/structured-log.js";

/**
 * No-op PlacementCtx stub. Used by providers in Phase 2 that don't yet
 * implement real placement (k8s, local, docker, firecracker). Phase 3
 * replaces these with real impls.
 *
 * env-var typed secrets still land via setEnv (env always works on every
 * provider). File-typed secrets are debug-logged and dropped.
 */
export class NoopPlacementCtx implements PlacementCtx {
  private readonly env: Record<string, string> = {};

  constructor(
    private readonly providerName: string,
    private readonly homeRoot: string = "/root",
  ) {}

  async writeFile(path: string, _mode: number, _bytes: Uint8Array): Promise<void> {
    logDebug("general", `secret_skipped: provider_stub provider=${this.providerName} verb=writeFile path=${path}`);
  }

  async appendFile(path: string, marker: string, _bytes: Uint8Array): Promise<void> {
    logDebug(
      "general",
      `secret_skipped: provider_stub provider=${this.providerName} verb=appendFile path=${path} marker=${marker}`,
    );
  }

  setEnv(key: string, value: string): void {
    this.env[key] = value;
  }

  setProvisionerConfig(_cfg: { kubeconfig?: Uint8Array }): void {
    logDebug("general", `secret_skipped: provider_stub provider=${this.providerName} verb=setProvisionerConfig`);
  }

  expandHome(rel: string): string {
    return rel.startsWith("~/") ? `${this.homeRoot}/${rel.slice(2)}` : rel;
  }

  getEnv(): Record<string, string> {
    return { ...this.env };
  }
}

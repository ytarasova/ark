/**
 * No-op PlacementCtx stub for the k8s providers (vanilla pod + Kata).
 *
 * Phase 2 wiring: until the k8s provider implements real placement (writing
 * via the k8s API, mounting Secrets, materializing kubeconfig), env-var
 * typed secrets still land via setEnv and file-typed secrets are dropped
 * with a debug log. Phase 3 swaps this out for a real impl.
 */

import { NoopPlacementCtx } from "../../secrets/noop-placement-ctx.js";

export class K8sPlacementCtx extends NoopPlacementCtx {
  constructor() {
    super("k8s", "/root");
  }
}

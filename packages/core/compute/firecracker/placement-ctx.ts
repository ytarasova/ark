/**
 * No-op PlacementCtx stub for the firecracker provider (local microVM
 * isolation). Phase 2 wiring: until the firecracker provider implements
 * real placement (likely via SSH into the VM on its loopback port), env-var
 * typed secrets still land via setEnv and file-typed secrets are dropped
 * with a debug log. Phase 3 swaps this out for a real impl.
 *
 * Default VM home is /root (matches the minimal rootfs used by Ark).
 */

import { NoopPlacementCtx } from "../../secrets/noop-placement-ctx.js";

export class FirecrackerPlacementCtx extends NoopPlacementCtx {
  constructor() {
    super("firecracker", "/root");
  }
}

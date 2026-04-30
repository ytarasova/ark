/**
 * No-op PlacementCtx stub for local providers (worktree, docker sidecar,
 * devcontainer, local firecracker).
 *
 * Phase 2 wiring: until local providers implement real placement, env-var
 * typed secrets still land via setEnv and file-typed secrets are dropped
 * with a debug log. Phase 3 swaps this out for a real impl that writes
 * directly to the local filesystem.
 *
 * The home root resolves from the host's `$HOME` so `~/.ssh/config` etc
 * expand to the operator's actual home directory.
 */

import { NoopPlacementCtx } from "../../core/secrets/noop-placement-ctx.js";

export class LocalPlacementCtx extends NoopPlacementCtx {
  constructor() {
    super("local", process.env.HOME ?? "/root");
  }
}

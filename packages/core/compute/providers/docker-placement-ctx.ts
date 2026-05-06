/**
 * No-op PlacementCtx stub for the docker provider (sidecar arkd container).
 *
 * Phase 2 wiring: until the docker provider implements real placement
 * (likely via `docker cp` or bind-mounted host paths), env-var typed
 * secrets still land via setEnv and file-typed secrets are dropped with
 * a debug log. Phase 3 swaps this out for a real impl.
 *
 * Default container home is /root (matches DEFAULT_IMAGE = ubuntu:22.04
 * which runs as root in the sidecar container).
 */

import { NoopPlacementCtx } from "../../secrets/noop-placement-ctx.js";

export class DockerPlacementCtx extends NoopPlacementCtx {
  constructor() {
    super("docker", "/root");
  }
}

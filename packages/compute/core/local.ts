/**
 * LocalCompute -- the host running `ark` itself. No provisioning, no stop,
 * no destroy: arkd runs on localhost:<config.ports.arkd> and the conductor
 * talks to it directly.
 *
 * Snapshot is not supported (the host cannot be serialised); snapshot()
 * and restore() throw `NotSupportedError`.
 */

import type { AppContext } from "../../core/app.js";
import type { Compute, ComputeCapabilities, ComputeHandle, ComputeKind, ProvisionOpts, Snapshot } from "./types.js";
import { NotSupportedError } from "./types.js";

export class LocalCompute implements Compute {
  readonly kind: ComputeKind = "local";
  readonly capabilities: ComputeCapabilities = {
    snapshot: false,
    pool: false,
    networkIsolation: false,
    provisionLatency: "instant",
  };

  private app!: AppContext;

  setApp(app: AppContext): void {
    this.app = app;
  }

  async provision(opts: ProvisionOpts): Promise<ComputeHandle> {
    // The host is always provisioned. We just mint a handle.
    const name = (opts.tags?.name as string | undefined) ?? "local";
    return {
      kind: this.kind,
      name,
      meta: { ...(opts.config ?? {}) },
    };
  }

  async start(_h: ComputeHandle): Promise<void> {
    throw new NotSupportedError(this.kind, "start");
  }

  async stop(_h: ComputeHandle): Promise<void> {
    throw new NotSupportedError(this.kind, "stop");
  }

  async destroy(_h: ComputeHandle): Promise<void> {
    throw new NotSupportedError(this.kind, "destroy");
  }

  getArkdUrl(_h: ComputeHandle): string {
    const port = this.app?.config?.ports?.arkd ?? 19300;
    return `http://localhost:${port}`;
  }

  async snapshot(_h: ComputeHandle): Promise<Snapshot> {
    throw new NotSupportedError(this.kind, "snapshot");
  }

  async restore(_s: Snapshot): Promise<ComputeHandle> {
    throw new NotSupportedError(this.kind, "restore");
  }
}

/**
 * Deferred PlacementCtx -- two-phase placement support for remote-medium providers.
 *
 * Background: typed-secret placement runs in two distinct windows.
 *
 *   Phase A (pre-launch, in dispatch/launch.ts:buildLaunchEnv):
 *     env-typed secrets must land in the launch env that gets handed to
 *     `executor.launch()`. The env is read SYNCHRONOUSLY on the dispatcher
 *     before `provider.launch()` ever runs, so env placement is forced to
 *     happen pre-launch.
 *
 *   Phase B (post-provision, in provider.launch):
 *     file-typed secrets need a live medium (an SSM session, a known IP,
 *     a docker exec channel, ...). For EC2 the instance_id is only known
 *     AFTER the provider provisions the instance during `launch()`. Trying
 *     to build the real EC2PlacementCtx in Phase A always failed with
 *     `Compute has no instance_id -- cannot build EC2 PlacementCtx`.
 *
 * The DeferredPlacementCtx bridges the two phases: it captures `setEnv`
 * synchronously (so `getEnv()` is correct in Phase A) and queues every
 * file / provisioner-config op for the provider to replay later via
 * `flush(realCtx)` once the medium is ready.
 *
 * Provider-side contract:
 *   - The dispatcher attaches the deferred ctx to the launch options it
 *     hands to `executor.launch()`. The executor passes it through to
 *     `provider.launch()` on `LaunchOpts.placement`.
 *   - The provider, post-provision (after `compute.config.instance_id` is
 *     set), builds a real ctx (e.g. EC2PlacementCtx, keyed off
 *     `instance_id` for the SSM transport) and calls
 *     `deferred.flush(realCtx)` before spawning the agent process.
 *
 * Providers that *can* do real placement pre-launch (e.g. k8s -- the API
 * client doesn't need a pod IP, it talks to the cluster control plane)
 * may still return a real ctx from `buildPlacementCtx` and skip the
 * deferred path.
 */

import type { PlacementCtx } from "./placement-types.js";

type QueuedOp =
  | { kind: "writeFile"; path: string; mode: number; bytes: Uint8Array }
  | { kind: "appendFile"; path: string; marker: string; bytes: Uint8Array }
  | { kind: "setProvisionerConfig"; cfg: { kubeconfig?: Uint8Array } };

export class DeferredPlacementCtx implements PlacementCtx {
  private readonly env: Record<string, string> = {};
  private readonly queue: QueuedOp[] = [];

  /**
   * @param homeRoot Used to expand "~/foo" tokens placers may pass through
   *   `expandHome()` while running pre-launch. Defaults to /home/ubuntu --
   *   the EC2 family is the only current consumer; override for other
   *   remote-medium hosts (e.g. /home/ec2-user, /root in a container).
   */
  constructor(private readonly homeRoot: string = "/home/ubuntu") {}

  async writeFile(path: string, mode: number, bytes: Uint8Array): Promise<void> {
    this.queue.push({ kind: "writeFile", path, mode, bytes });
  }

  async appendFile(path: string, marker: string, bytes: Uint8Array): Promise<void> {
    this.queue.push({ kind: "appendFile", path, marker, bytes });
  }

  setEnv(key: string, value: string): void {
    this.env[key] = value;
  }

  setProvisionerConfig(cfg: { kubeconfig?: Uint8Array }): void {
    this.queue.push({ kind: "setProvisionerConfig", cfg });
  }

  expandHome(rel: string): string {
    return rel.startsWith("~/") ? `${this.homeRoot}/${rel.slice(2)}` : rel;
  }

  getEnv(): Record<string, string> {
    return { ...this.env };
  }

  /**
   * Replay queued ops onto a real ctx (post-provision). Order is preserved:
   * placers occasionally chain writeFile + appendFile against related paths
   * (ssh-private-key writes the key then appends to ~/.ssh/config), so an
   * out-of-order replay would change observable behaviour.
   */
  async flush(target: PlacementCtx): Promise<void> {
    for (const op of this.queue) {
      switch (op.kind) {
        case "writeFile":
          await target.writeFile(op.path, op.mode, op.bytes);
          break;
        case "appendFile":
          await target.appendFile(op.path, op.marker, op.bytes);
          break;
        case "setProvisionerConfig":
          target.setProvisionerConfig(op.cfg);
          break;
      }
    }
  }

  /** True when at least one file / provisioner op is queued for replay. */
  hasDeferred(): boolean {
    return this.queue.length > 0;
  }

  /** For tests -- read-only window into the queued ops. */
  get queuedOps(): readonly QueuedOp[] {
    return this.queue;
  }
}

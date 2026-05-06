/**
 * DirectIsolation -- launches the agent directly via arkd, no further
 * container / devcontainer / compose wrapper. This is the semantic equivalent
 * of today's `LocalWorktreeProvider.launch` path.
 *
 * `prepare` and `shutdown` are no-ops: the host is already set up (arkd is
 * running, tmux exists) and there's nothing to tear down between agents.
 */

import { ArkdClient } from "../../../arkd/client/index.js";
import type { AppContext } from "../../app.js";
import { buildAgentHandle } from "../core/handle-helpers.js";
import type {
  AgentHandle,
  Compute,
  ComputeHandle,
  IsolationKind,
  Isolation,
  LaunchOpts,
  PrepareCtx,
} from "../core/types.js";

export class DirectIsolation implements Isolation {
  readonly kind: IsolationKind = "direct";
  readonly name = "direct";

  /** Override hook for tests; when null we build a fresh `ArkdClient`. */
  private clientFactory: ((url: string) => ArkdClient) | null = null;

  constructor(private readonly app: AppContext) {}

  /** Test-only: swap in a stub `ArkdClient` factory. */
  setClientFactory(factory: (url: string) => ArkdClient): void {
    this.clientFactory = factory;
  }

  async prepare(_compute: Compute, _h: ComputeHandle, _ctx: PrepareCtx): Promise<void> {
    // No-op: direct isolation needs no per-compute preparation.
  }

  async launchAgent(compute: Compute, h: ComputeHandle, opts: LaunchOpts): Promise<AgentHandle> {
    const url = compute.getArkdUrl(h);
    const client = this.clientFactory ? this.clientFactory(url) : new ArkdClient(url);
    await client.launchAgent({
      sessionName: opts.tmuxName,
      script: opts.launcherContent,
      workdir: opts.workdir,
    });
    return this.attachAgent(compute, h, opts.tmuxName);
  }

  attachAgent(compute: Compute, h: ComputeHandle, sessionName: string): AgentHandle {
    const factory = this.clientFactory ?? ((url: string) => new ArkdClient(url));
    return buildAgentHandle(sessionName, () => compute.getArkdUrl(h), factory);
  }

  async shutdown(_compute: Compute, _h: ComputeHandle): Promise<void> {
    // No-op: nothing to tear down -- the host outlives every agent.
  }
}

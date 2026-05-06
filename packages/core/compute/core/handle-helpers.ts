/**
 * Helpers for attaching post-launch operations to ComputeHandle / AgentHandle.
 *
 * Every Compute impl returns handles that need a `getMetrics()` method, and
 * every Isolation needs to build AgentHandles with `kill()`, `captureOutput()`,
 * and `checkAlive()` closures bound to the right arkd client. These helpers
 * centralise the wire-format mapping (arkd `/snapshot`, `/agent/kill`,
 * `/agent/capture`, `/agent/status`) so individual impls only have to supply
 * the URL.
 *
 * Production impls hand in a real `ArkdClient` factory; tests inject stubs
 * via the same seam.
 */

import type { ArkdClient } from "../../../arkd/client/index.js";
import type { AgentHandle, ComputeHandle, ComputeSnapshot } from "./types.js";

/** Factory contract -- production wires `(url) => new ArkdClient(url)`. */
export type ArkdClientFactory = (url: string) => ArkdClient;

/**
 * Decorate a freshly-minted ComputeHandle with the `getMetrics` method.
 * The closure captures the arkd URL via `getUrl()` so per-call resolution
 * is honoured (eg. EC2's port-forward port may change between calls).
 *
 * Returns the same handle object (mutated in place) so callers can keep
 * their existing `return { kind, name, meta }` shape and just wrap the
 * literal in `attachComputeMethods({ ... }, getUrl, factory)`.
 */
export function attachComputeMethods<H extends ComputeHandle>(
  handle: H,
  getUrl: () => string,
  factory: ArkdClientFactory,
): H {
  // Cast through `any` so we can install the method on a structural type
  // without TS demanding a re-typed handle. The return type still satisfies
  // the ComputeHandle interface.
  const h = handle as any;
  h.getMetrics = async function getMetrics(): Promise<ComputeSnapshot> {
    const client = factory(getUrl());
    return (await client.snapshot()) as unknown as ComputeSnapshot;
  };
  return handle;
}

/**
 * Build an AgentHandle bound to the supplied arkd client + sessionName.
 * Used by both `Isolation.launchAgent` (right after a successful arkd
 * launchAgent call) and `Isolation.attachAgent` (rehydration from a
 * persisted session id).
 */
export function buildAgentHandle(
  sessionName: string,
  getUrl: () => string,
  factory: ArkdClientFactory,
  meta?: Record<string, unknown>,
): AgentHandle {
  return {
    sessionName,
    meta,
    async kill(): Promise<void> {
      const client = factory(getUrl());
      await client.killAgent({ sessionName });
    },
    async captureOutput(opts?: { lines?: number }): Promise<string> {
      const client = factory(getUrl());
      const res = await client.captureOutput({ sessionName, lines: opts?.lines });
      return res.output;
    },
    async checkAlive(): Promise<boolean> {
      try {
        const client = factory(getUrl());
        const res = await client.agentStatus({ sessionName });
        return res.running;
      } catch {
        // arkd unreachable -- treat as not alive. Status pollers further
        // up the stack distinguish "transient probe failure" from "agent
        // gone" via their own retry layer; this method's contract is just
        // a boolean snapshot.
        return false;
      }
    },
  };
}

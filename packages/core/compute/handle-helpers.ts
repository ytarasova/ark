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

import type { ArkdClient } from "../../arkd/client/index.js";
import type {
  AgentHandle,
  ComputeHandle,
  ComputeKind,
  ComputeSnapshot,
  MethodedComputeHandle,
  PersistedComputeHandleState,
  SpawnProcessOpts,
} from "./types.js";

/** Factory contract -- production wires `(url) => new ArkdClient(url)`. */
export type ArkdClientFactory = (url: string) => ArkdClient;

/**
 * Decorate a freshly-minted ComputeHandle with the methods every
 * arkd-backed handle owns: `getMetrics` (delegates to `/snapshot`) and the
 * generic process-supervisor trio `spawnProcess` / `killProcess` /
 * `statusProcess` (delegates to `/process/{spawn,kill,status}`).
 *
 * The closures capture the arkd URL via `getUrl()` so per-call resolution
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
): H & MethodedComputeHandle {
  // Cast through `any` so we can install methods on a structural type
  // without TS demanding a re-typed handle. The return type still satisfies
  // the ComputeHandle interface.
  const h = handle as any;
  h.getMetrics = async function getMetrics(): Promise<ComputeSnapshot> {
    const client = factory(getUrl());
    return (await client.snapshot()) as unknown as ComputeSnapshot;
  };
  h.spawnProcess = async function spawnProcess(opts: SpawnProcessOpts): Promise<{ pid: number }> {
    const client = factory(getUrl());
    const res = await client.spawnProcess(opts);
    return { pid: res.pid };
  };
  h.killProcess = async function killProcess(
    procHandle: string,
    signal?: "SIGTERM" | "SIGKILL",
  ): Promise<{ wasRunning: boolean }> {
    const client = factory(getUrl());
    const res = await client.killProcess({ handle: procHandle, signal });
    return { wasRunning: res.wasRunning };
  };
  h.statusProcess = async function statusProcess(
    procHandle: string,
  ): Promise<{ running: boolean; pid?: number; exitCode?: number }> {
    const client = factory(getUrl());
    return client.statusProcess({ handle: procHandle });
  };
  return handle as H & MethodedComputeHandle;
}

/**
 * Default `Compute.rehydrateHandle` for arkd-backed impls. Reconstructs the
 * handle struct from persisted state and wires methods via
 * `attachComputeMethods`. Each impl typically delegates to this helper:
 *
 *     rehydrateHandle(state) {
 *       return rehydrateArkdBackedHandle(state, (h) => this.getArkdUrl(h), this.clientFactory);
 *     }
 *
 * Trusts the persisted `meta` shape -- by construction it was built by the
 * impl's own `provision` / `attachExistingHandle` so the typed fields each
 * impl reads (instance_id, pod_name, vm_id, ...) are guaranteed present.
 */
export function rehydrateArkdBackedHandle<MetaT extends Record<string, unknown>>(
  state: PersistedComputeHandleState,
  getUrl: (h: ComputeHandle) => string,
  factory: ArkdClientFactory,
): MethodedComputeHandle {
  const handle: ComputeHandle = {
    kind: state.kind as ComputeKind,
    name: state.name,
    meta: state.meta as MetaT,
  };
  return attachComputeMethods(handle, () => getUrl(handle), factory);
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
      // Propagate transport errors. The status-poller's outer try/catch
      // distinguishes "transient probe failure" (keeps session running)
      // from "definitive not_found" (running === false). Swallowing here
      // would silently flip healthy sessions to completed on a single
      // arkd outage; see status-poller.ts:90 contract.
      const client = factory(getUrl());
      const res = await client.agentStatus({ sessionName });
      return res.running;
    },
    async sendUserMessage(content: string): Promise<{ delivered: boolean }> {
      // Publish on the global `user-input` channel with `control: "interrupt"`
      // so the agent's user-message-stream consumer (sees this envelope on
      // every running agent and filters by sessionName) pushes the content
      // into its PromptQueue and triggers an SDK abort+resume so the
      // message takes effect mid-turn instead of waiting for the current
      // turn's tool calls to finish. See the legacy
      // `ArkdBackedProvider.sendUserMessage` for the full rationale.
      const client = factory(getUrl());
      const res = await client.publishToChannel("user-input", {
        session: sessionName,
        content,
        control: "interrupt",
      });
      return { delivered: res.delivered };
    },
  };
}

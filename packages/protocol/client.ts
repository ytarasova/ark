/**
 * ArkClient -- typed JSON-RPC 2.0 client for the Ark protocol.
 *
 * Thin facade over domain-scoped mixin clients under `./clients/*`.
 * Owns the transport, pending-promise bookkeeping, connection status,
 * and notification dispatch. Every RPC method comes from one of the
 * mixins via `applyMixins` -- the public surface is unchanged from the
 * monolithic pre-refactor version.
 *
 * Split layout (kept at <= 25 methods each):
 *   - SessionClient        (session lifecycle + queries + worktree)
 *   - SessionInteractClient (messaging / gates / todos / inputs / spawn / pause + extended session ops)
 *   - ComputeClient        (compute / template / cluster / group / k8s + agent-G)
 *   - AgentClient          (agent / skill / recipe / runtime + agent-C)
 *   - FlowClient           (flow / execution)
 *   - AdminTenantClient    (tenant CRUD + agent-F tenant auth bindings)
 *   - AdminTeamClient      (team / user / tenant policy / api-key + agent-B)
 *   - SecretsClient        (secret / secret-blob, agent-F blob half)
 *   - TicketsClient        (trigger / connector / integration)
 *   - ObservabilityClient  (costs / eval / dashboard + agent-E conductor/sage)
 *   - SystemClient         (config / profile / history / tools / mcp / schedule)
 */

import type { Transport, ConnectionStatus } from "./transport.js";
import {
  createRequest,
  createNotification,
  isResponse,
  isError,
  isNotification,
  ARK_VERSION,
  RpcError,
  type RequestId,
  type JsonRpcMessage,
} from "./types.js";
import type { RpcFn } from "./clients/rpc.js";
import { SessionClient } from "./clients/session.js";
import { SessionInteractClient } from "./clients/session-interact.js";
import { ComputeClient } from "./clients/compute.js";
import { AgentClient } from "./clients/agent.js";
import { FlowClient } from "./clients/flow.js";
import { AdminTenantClient } from "./clients/admin-tenant.js";
import { AdminTeamClient } from "./clients/admin-team.js";
import { SecretsClient } from "./clients/secrets.js";
import { TicketsClient } from "./clients/tickets.js";
import { ObservabilityClient } from "./clients/observability.js";
import { SystemClient } from "./clients/system.js";

// Re-exports so callers that previously imported these types directly from
// `protocol/client.js` keep compiling unchanged.
export type { ReplayStep, SessionSnapshotRef } from "./clients/session.js";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/**
 * Copy own enumerable methods from each source prototype onto the target
 * prototype. Uses `defineProperty` so inherited accessors stay intact.
 */
function applyMixins(target: any, sources: any[]): void {
  for (const src of sources) {
    for (const name of Object.getOwnPropertyNames(src.prototype)) {
      if (name === "constructor") continue;
      const desc = Object.getOwnPropertyDescriptor(src.prototype, name);
      if (!desc) continue;
      Object.defineProperty(target.prototype, name, desc);
    }
  }
}

// Interface merge: declare that ArkClient carries every mixin's public surface.
// TypeScript treats this as a structural contract; the runtime methods are
// wired by `applyMixins` below.
export interface ArkClient
  extends
    SessionClient,
    SessionInteractClient,
    ComputeClient,
    AgentClient,
    FlowClient,
    AdminTenantClient,
    AdminTeamClient,
    SecretsClient,
    TicketsClient,
    ObservabilityClient,
    SystemClient {}

export class ArkClient {
  private transport: Transport;
  private idCounter = 0;
  private pending = new Map<RequestId, Pending>();
  private listeners = new Map<string, Set<(data: any) => void>>();
  private _connectionStatus: ConnectionStatus = "connected";
  private _statusHandlers = new Set<(status: ConnectionStatus) => void>();
  private _lastSubscribe?: string[];
  // The mixins read `this.rpc` to issue RPC calls -- `applyMixins` copies
  // their method bodies onto this class, so `this` points at ArkClient at
  // runtime. The rpc field must be non-private because the interface merge
  // below surfaces it structurally on ArkClient.
  readonly rpc!: RpcFn;

  constructor(transport: Transport) {
    this.transport = transport;
    this.transport.onMessage((msg) => this.handleMessage(msg));
    this.rpc = this.rpcCall.bind(this) as RpcFn;
  }

  /** Current connection status. */
  get connectionStatus(): ConnectionStatus {
    return this._connectionStatus;
  }

  /** Subscribe to connection status changes. Returns an unsubscribe function. */
  onConnectionStatus(handler: (status: ConnectionStatus) => void): () => void {
    this._statusHandlers.add(handler);
    return () => {
      this._statusHandlers.delete(handler);
    };
  }

  /** Called by the transport layer (or externally) to update connection status. */
  setConnectionStatus(status: ConnectionStatus): void {
    if (status === this._connectionStatus) return;
    this._connectionStatus = status;
    for (const h of this._statusHandlers) h(status);
    // On reconnect, re-initialize subscriptions.
    // TODO(follow-up): the ArkClient has no retry/backoff for failed
    // re-subscribe -- if this throws, the client stays connected but
    // receives no further notifications until a new setConnectionStatus
    // edge. Track as a protocol-client resilience task.
    if (status === "connected" && this._lastSubscribe) {
      this.initialize({ subscribe: this._lastSubscribe }).catch((err) => {
        if (typeof process !== "undefined" && process.env && process.env.ARK_DEBUG) {
          console.warn(
            `[ark-client] re-subscribe on reconnect failed:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      });
    }
  }

  private handleMessage(msg: JsonRpcMessage): void {
    if (isResponse(msg)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg.result);
      }
      return;
    }
    if (isError(msg)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.reject(new RpcError(msg.error.message, msg.error.code, msg.error.data));
      }
      return;
    }
    if (isNotification(msg)) {
      const handlers = this.listeners.get(msg.method);
      if (handlers) {
        for (const h of handlers) h(msg.params ?? {});
      }
      return;
    }
  }

  private rpcCall<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
    const id = ++this.idCounter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.transport.send(createRequest(id, method, params));
    });
  }

  async initialize(opts?: { subscribe?: string[] }): Promise<{ server: { name: string; version: string } }> {
    const subscribe = opts?.subscribe ?? ["**"];
    this._lastSubscribe = subscribe;
    const result = await this.rpcCall<{ server: { name: string; version: string } }>("initialize", {
      client: { name: "ark-client", version: ARK_VERSION },
      subscribe,
    });
    this.transport.send(createNotification("initialized"));
    return result;
  }

  on(event: string, handler: (data: any) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
  }

  off(event: string, handler: (data: any) => void): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(handler);
      if (set.size === 0) this.listeners.delete(event);
    }
  }

  close(): void {
    const err = new Error("ArkClient closed");
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
    this.listeners.clear();
    this.transport.close();
  }
}

// Wire every mixin's methods onto ArkClient.prototype. Each mixin reads
// `this.rpc` -- that's the bound `rpcCall` set in the constructor above,
// so the transport + pending-promise bookkeeping flows through `this`.
applyMixins(ArkClient, [
  SessionClient,
  SessionInteractClient,
  ComputeClient,
  AgentClient,
  FlowClient,
  AdminTenantClient,
  AdminTeamClient,
  SecretsClient,
  TicketsClient,
  ObservabilityClient,
  SystemClient,
]);

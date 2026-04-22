/**
 * Control-plane binding module.
 *
 * `buildControlPlaneBindings(cradle)` returns the adapters wired for the
 * hosted multi-tenant deployment: Postgres stores, Redis pub/sub, object
 * storage for workspaces, SSH-based process execution, Vault-managed
 * secrets.
 *
 * Every adapter in this binding is currently a stub that throws
 * `"not migrated yet"`. Each stub is an explicit TODO for the Slice 1+
 * migration; the composition-root shape is already in place so the dispatch
 * in `app.ts` can switch on it the moment the real adapters land.
 */

import type {
  SessionStore,
  ComputeStore,
  EventBus,
  EventStore,
  Workspace,
  ProcessRunner,
  Clock,
  Logger,
  Tracer,
  SecretStore,
} from "../../ports/index.js";

import { ControlPlaneSessionStore } from "./session-store.js";
import { ControlPlaneComputeStore } from "./compute-store.js";
import { RedisEventBus } from "./event-bus.js";
import { ControlPlaneEventStore } from "./event-store.js";
import { ObjectStoreWorkspace } from "./workspace.js";
import { RemoteProcessRunner } from "./process-runner.js";
import { ControlPlaneClock } from "./clock.js";
import { CloudLogger } from "./logger.js";
import { ControlPlaneOtlpTracer } from "./tracer.js";
import { VaultSecretStore } from "./secret-store.js";

export type BindingCradle = Record<string, unknown>;

export interface ControlPlaneBindings {
  sessionStore: SessionStore;
  computeStore: ComputeStore;
  eventBus: EventBus;
  eventStore: EventStore;
  workspace: Workspace;
  processRunner: ProcessRunner;
  clock: Clock;
  logger: Logger;
  tracer: Tracer;
  secretStore: SecretStore;
}

export function buildControlPlaneBindings(_cradle: BindingCradle): ControlPlaneBindings {
  return {
    sessionStore: new ControlPlaneSessionStore(),
    computeStore: new ControlPlaneComputeStore(),
    eventBus: new RedisEventBus(),
    eventStore: new ControlPlaneEventStore((_cradle as { db: import("../../database/index.js").DatabaseAdapter }).db),
    workspace: new ObjectStoreWorkspace(),
    processRunner: new RemoteProcessRunner(),
    clock: new ControlPlaneClock(),
    logger: new CloudLogger(),
    tracer: new ControlPlaneOtlpTracer(),
    secretStore: new VaultSecretStore(),
  };
}

export {
  ControlPlaneSessionStore,
  ControlPlaneComputeStore,
  RedisEventBus,
  ControlPlaneEventStore,
  ObjectStoreWorkspace,
  RemoteProcessRunner,
  ControlPlaneClock,
  CloudLogger,
  ControlPlaneOtlpTracer,
  VaultSecretStore,
};

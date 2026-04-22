/**
 * Local binding module.
 *
 * `buildLocalBindings(cradle)` returns the set of adapter instances wired for
 * a single-node `ark` CLI install: SQLite, in-process event bus, filesystem
 * workspace, local sub-processes, stdout + file logs.
 *
 * In this scaffolding PR every adapter is a stub that throws
 * `"not migrated yet"`. The real wiring lands in Slice 1 of the hex
 * migration (see `.workflow/audit/4-di-plan.md`). The point of this file is
 * that the composition-root shape is in place and can be imported.
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

import { LocalSessionStore } from "./session-store.js";
import { LocalComputeStore } from "./compute-store.js";
import { LocalEventBus } from "./event-bus.js";
import { LocalEventStore } from "./event-store.js";
import { LocalWorkspace } from "./workspace.js";
import { LocalProcessRunner } from "./process-runner.js";
import { SystemClock } from "./clock.js";
import { FileLogger } from "./logger.js";
import { OtlpTracer } from "./tracer.js";
import { EnvSecretStore } from "./secret-store.js";

/**
 * Minimal cradle shape consumed by the binding factory. Intentionally
 * Record-typed so the scaffolding doesn't take a hard dependency on the full
 * `Cradle` interface in `container.ts`; the real migration will tighten this.
 */
export type BindingCradle = Record<string, unknown>;

export interface LocalBindings {
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

export function buildLocalBindings(_cradle: BindingCradle): LocalBindings {
  return {
    sessionStore: new LocalSessionStore(),
    computeStore: new LocalComputeStore(),
    eventBus: new LocalEventBus(),
    eventStore: new LocalEventStore((_cradle as { db: import("../../database/index.js").DatabaseAdapter }).db),
    workspace: new LocalWorkspace(),
    processRunner: new LocalProcessRunner(),
    clock: new SystemClock(),
    logger: new FileLogger(),
    tracer: new OtlpTracer(),
    secretStore: new EnvSecretStore(),
  };
}

export {
  LocalSessionStore,
  LocalComputeStore,
  LocalEventBus,
  LocalEventStore,
  LocalWorkspace,
  LocalProcessRunner,
  SystemClock,
  FileLogger,
  OtlpTracer,
  EnvSecretStore,
};

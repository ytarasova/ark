/**
 * Test binding module.
 *
 * `buildTestBindings(cradle)` returns in-memory / mock adapters suitable for
 * unit tests: no SQLite, no real filesystem, no sub-processes. Replaces the
 * current `AppContext.forTest()` which boots a real temp dir + real SQLite.
 *
 * All adapters are stubs in this scaffolding PR. Slice 1 of the migration
 * wires the real in-memory implementations.
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

import { InMemorySessionStore } from "./session-store.js";
import { InMemoryComputeStore } from "./compute-store.js";
import { TestEventBus } from "./event-bus.js";
import { InMemoryEventStore } from "./event-store.js";
import { InMemoryWorkspace } from "./workspace.js";
import { MockProcessRunner } from "./process-runner.js";
import { MockClock } from "./clock.js";
import { MemoryLogger } from "./logger.js";
import { NoopTracer } from "./tracer.js";
import { MapSecretStore } from "./secret-store.js";

export type BindingCradle = Record<string, unknown>;

export interface TestBindings {
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

export function buildTestBindings(_cradle: BindingCradle): TestBindings {
  return {
    sessionStore: new InMemorySessionStore(),
    computeStore: new InMemoryComputeStore(),
    eventBus: new TestEventBus(),
    eventStore: new InMemoryEventStore(),
    workspace: new InMemoryWorkspace(),
    processRunner: new MockProcessRunner(),
    clock: new MockClock(),
    logger: new MemoryLogger(),
    tracer: new NoopTracer(),
    secretStore: new MapSecretStore(),
  };
}

export {
  InMemorySessionStore,
  InMemoryComputeStore,
  TestEventBus,
  InMemoryEventStore,
  InMemoryWorkspace,
  MockProcessRunner,
  MockClock,
  MemoryLogger,
  NoopTracer,
  MapSecretStore,
};

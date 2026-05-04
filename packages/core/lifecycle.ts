/**
 * Lifecycle -- orchestrates startup order for every long-lived service
 * registered in the DI container.
 *
 * Design
 * ------
 * awilix handles dispose order automatically (reverse of resolution order)
 * as long as every startable service is registered with a `disposer`. Our
 * job is to resolve them in the correct start order and call `start()` on
 * each. That is exactly what this class does: walk a topologically-ordered
 * list of cradle keys, resolve them, and call `start()`.
 *
 * Resolution has two useful side effects:
 *   1. It runs the factory (eg. constructs `ConductorLauncher`), so the
 *      instance exists + is tracked by the container's disposer list.
 *   2. The order of resolution determines the reverse-order dispose.
 *
 * New services
 * ------------
 * To add a new service to the lifecycle:
 *   1. Register it in a di/ module with a disposer.
 *   2. Append its cradle key to `START_ORDER` below at the right depth.
 *   3. That's it -- shutdown order inverts automatically.
 */

import type { AppContainer, Cradle } from "./container.js";
import { logDebug } from "./observability/structured-log.js";

/**
 * Canonical start order. Each key resolves to a service with a
 * `start()` method (sync or async). Awilix disposes in reverse order.
 *
 * Ordering constraints (top to bottom, earlier = started first):
 *   1. wiring     -- side-effectful configuration (otlp / telemetry /
 *                    provider resolver / plugin registry / event bus)
 *   2. compute providers (legacy + new kinds) -- must exist before any
 *      conductor code paths that touch them
 *   3. tensorZero (optional gateway, needed by router)
 *   4. router     -- depends on tensorZero URL
 *   5. conductor  -- HTTP server; agents + web both talk to it
 *   6. arkd       -- agent daemon; forwards to conductor
 *   7. metrics poller
 *   8. maintenance pollers (purge, tmux status, notify daemon)
 *   9. boot file cleanup (one-shot)
 *  10. signal handlers (last so ctrl-c hits a fully-booted app)
 */
const START_ORDER: (keyof Cradle)[] = [
  "serviceWiring",
  "computeProvidersBoot",
  "tensorZeroLauncher",
  "routerLauncher",
  "conductorLauncher",
  "arkdLauncher",
  "metricsPoller",
  "maintenancePollers",
  "bootCleanup",
  "signalHandlers",
  // sessionDrain is resolved LAST so awilix disposes it FIRST during shutdown.
  // Its disposer drains + stops sessions while the conductor/arkd are still up.
  "sessionDrain",
];

export interface StartableService {
  start(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export class Lifecycle {
  constructor(private readonly container: AppContainer) {}

  async start(): Promise<void> {
    for (const key of START_ORDER) {
      const service = this.container.resolve(key) as StartableService | undefined;
      if (!service) continue;
      if (typeof service.start !== "function") {
        logDebug("general", `lifecycle: ${key} has no start() -- skipping`);
        continue;
      }
      await Promise.resolve(service.start());
    }
  }
}

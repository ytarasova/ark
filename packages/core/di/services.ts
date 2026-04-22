/**
 * DI registrations for application services.
 *
 * Services are singleton-scoped (one instance per container). They receive
 * dependencies via constructor arguments resolved from the container's
 * cradle. Factories use `asFunction` with explicit cradle reads so
 * registrations survive `bun build --compile` minification.
 */

import { asFunction, Lifetime } from "awilix";
import type { AppContainer } from "../container.js";
import type { DatabaseAdapter } from "../database/index.js";
import type { AppContext } from "../app.js";
import type { SessionRepository } from "../repositories/session.js";
import type { ComputeRepository } from "../repositories/compute.js";
import type { EventRepository } from "../repositories/event.js";
import type { MessageRepository } from "../repositories/message.js";
import { SessionService, ComputeService, HistoryService } from "../services/index.js";

/**
 * Register the three core services.
 *
 * SessionService is the only one that depends on AppContext (for legacy
 * session-orchestration delegation). The AppContext is registered in the
 * container before services so `app` resolves successfully.
 */
export function registerServices(container: AppContainer): void {
  container.register({
    sessionService: asFunction(
      (c: { sessions: SessionRepository; events: EventRepository; messages: MessageRepository; app: AppContext }) =>
        new SessionService(c.sessions, c.events, c.messages, c.app),
      { lifetime: Lifetime.SINGLETON },
    ),

    computeService: asFunction((c: { computes: ComputeRepository }) => new ComputeService(c.computes), {
      lifetime: Lifetime.SINGLETON,
    }),

    historyService: asFunction((c: { db: DatabaseAdapter }) => new HistoryService(c.db), {
      lifetime: Lifetime.SINGLETON,
    }),
  });
}

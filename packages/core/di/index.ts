/**
 * DI composition root.
 *
 * `buildContainer(app, db)` composes the persistence, services, and runtime
 * registrations into a single AppContainer ready for resolution.
 *
 * Boot order within the container:
 *   1. config + app are registered as values (set before buildContainer runs).
 *   2. db is registered by the caller (async open -- SQLite vs Postgres).
 *   3. Repositories + resource stores (depend on db + config).
 *   4. Runtime singletons (pricing, parsers, plugin registry, snapshot store).
 *   5. Services (depend on repos + app).
 *
 * To add a new service, edit the appropriate module (persistence / services /
 * runtime) and extend the Cradle in container.ts. Test doubles can be swapped
 * in via `container.register({ <key>: asValue(fake) })` after boot.
 */

import { asValue } from "awilix";
import type { AppContainer, AppBootOptions } from "../container.js";
import { createAppContainer } from "../container.js";
import type { ArkConfig } from "../config.js";
import type { IDatabase } from "../database/index.js";
import type { AppContext } from "../app.js";
import { registerDatabase, registerRepositories, registerResourceStores } from "./persistence.js";
import { registerServices } from "./services.js";
import { registerRuntime } from "./runtime.js";

export { registerDatabase, registerRepositories, registerResourceStores } from "./persistence.js";
export { registerServices } from "./services.js";
export { registerRuntime } from "./runtime.js";

/**
 * Build a fully wired container.
 *
 * Registration order matters: repos depend on db + config, services depend
 * on repos, transcript parsers depend on the sessions repo, etc. Every
 * factory reads from the cradle, so all dependencies must be registered
 * before first resolution.
 */
export function buildContainer(opts: {
  app: AppContext;
  config: ArkConfig;
  db: IDatabase;
  bootOptions?: AppBootOptions;
}): AppContainer {
  const container = createAppContainer();

  // 1. Root values -- required by every other factory.
  container.register({
    config: asValue(opts.config),
    app: asValue(opts.app),
    bootOptions: asValue(opts.bootOptions ?? {}),
  });

  // 2. Database (with disposer).
  registerDatabase(container, opts.db);

  // 3. Persistence layer.
  registerRepositories(container);
  registerResourceStores(container);

  // 4. Runtime singletons + infra launchers.
  registerRuntime(container);

  // 5. Services.
  registerServices(container);

  return container;
}

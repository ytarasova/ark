/**
 * DI registration for `AppMode` -- the deployment-mode descriptor.
 *
 * This is the single point in the codebase that picks `LocalAppMode` vs
 * `HostedAppMode` based on `config.database.url`. Every other caller resolves
 * `app.mode` (or pulls it from the cradle) and does capability-based dispatch.
 */

import { asFunction, Lifetime } from "awilix";
import type { AppContainer } from "../container.js";
import type { ArkConfig } from "../config.js";
import type { AppContext } from "../app.js";
import { buildAppMode, type AppMode } from "../modes/app-mode.js";

export function registerAppMode(container: AppContainer): void {
  container.register({
    mode: asFunction((c: { config: ArkConfig; app: AppContext }) => buildAppMode(c.config, c.app), {
      lifetime: Lifetime.SINGLETON,
    }),
  });
}

// Re-export for external consumers.
export type { AppMode };

import type { Router } from "./router.js";
import { registerSessionHandlers } from "./handlers/session.js";
import { registerResourceHandlers } from "./handlers/resource.js";
import { registerMessagingHandlers } from "./handlers/messaging.js";
import { registerConfigHandlers } from "./handlers/config.js";
import { registerHistoryHandlers } from "./handlers/history.js";
import { registerToolsHandlers } from "./handlers/tools.js";
import { registerMetricsHandlers } from "./handlers/metrics.js";

export function registerAllHandlers(router: Router): void {
  router.handle("initialize", async (params) => ({
    server: { name: "ark-server", version: "0.8.0" },
    capabilities: { notifications: true, bidirectional: true },
  }));

  registerSessionHandlers(router);
  registerResourceHandlers(router);
  registerMessagingHandlers(router);
  registerConfigHandlers(router);
  registerHistoryHandlers(router);
  registerToolsHandlers(router);
  registerMetricsHandlers(router);
}

import type { Router } from "./router.js";
import type { AppContext } from "../core/app.js";
import { ARK_VERSION } from "../protocol/types.js";
import { registerSessionHandlers } from "./handlers/session.js";
import { registerResourceHandlers } from "./handlers/resource.js";
import { registerMessagingHandlers } from "./handlers/messaging.js";
import { registerConfigHandlers } from "./handlers/config.js";
import { registerHistoryHandlers } from "./handlers/history.js";
import { registerToolsHandlers } from "./handlers/tools.js";
import { registerMetricsHandlers } from "./handlers/metrics.js";
import { registerMemoryHandlers } from "./handlers/memory.js";
import { registerScheduleHandlers } from "./handlers/schedule.js";

export function registerAllHandlers(router: Router, app: AppContext): void {
  router.handle("initialize", async (params, _notify) => ({
    server: { name: "ark-server", version: ARK_VERSION },
    capabilities: { notifications: true, bidirectional: true },
  }));

  registerSessionHandlers(router, app);
  registerResourceHandlers(router, app);
  registerMessagingHandlers(router, app);
  registerConfigHandlers(router, app);
  registerHistoryHandlers(router, app);
  registerToolsHandlers(router, app);
  registerMetricsHandlers(router, app);
  registerMemoryHandlers(router, app);
  registerScheduleHandlers(router, app);
}

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import * as core from "../../core/index.js";
import { getProvider } from "../../compute/index.js";
import { getAllSessionCosts } from "../../core/costs.js";
import type { MetricsSnapshotParams } from "../../types/index.js";

export function registerMetricsHandlers(router: Router, app: AppContext): void {
  router.handle("metrics/snapshot", async (p) => {
    const { computeName } = extract<MetricsSnapshotParams>(p, []);
    const resolved = computeName ?? "local";
    const compute = core.getCompute(resolved);
    if (!compute) return { snapshot: null };
    const provider = getProvider(compute.provider);
    if (!provider?.getMetrics) return { snapshot: null };
    const snapshot = await provider.getMetrics(compute);
    return { snapshot };
  });

  router.handle("costs/read", async () => {
    const sessions = core.listSessions({ limit: 500 });
    const { sessions: costs, total } = getAllSessionCosts(sessions);
    return { costs, total };
  });
}

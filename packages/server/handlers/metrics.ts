import type { Router } from "../router.js";
import * as core from "../../core/index.js";
import { getProvider } from "../../compute/index.js";
import { getAllSessionCosts } from "../../core/costs.js";

export function registerMetricsHandlers(router: Router): void {
  router.handle("metrics/snapshot", async (p) => {
    const computeName = (p.computeName as string) ?? "local";
    const compute = core.getCompute(computeName);
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

import type { Router } from "../router.js";
import * as core from "../../core/index.js";
import { getProvider } from "../../compute/index.js";

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

  router.handle("costs/read", async () => ({ costs: [] }));
}

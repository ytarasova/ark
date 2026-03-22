import { getProvider } from "../compute/index.js";
import { state } from "./state.js";
import { renderAll } from "./render/index.js";

async function refreshHostMetrics() {
  for (const h of state.hosts) {
    if (h.status !== "running") continue;
    const provider = getProvider(h.provider);
    if (!provider) continue;
    try {
      const snap = await provider.getMetrics(h);
      state.hostSnapshots.set(h.name, snap);
    } catch { /* skip */ }
  }
}

export function startPolling() {
  let polling = false;
  setInterval(async () => {
    if (state.tab !== "hosts" || polling) return;
    polling = true;
    try { await refreshHostMetrics(); } finally { polling = false; }
    renderAll();
  }, 10_000);

  // Auto-refresh
  setInterval(renderAll, 3000);
}

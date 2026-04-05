/**
 * Central compute action dispatcher. Every mutation goes through
 * asyncState.run() which automatically refreshes via onComplete.
 */

import { useArkClient } from "./useArkClient.js";
import type { AsyncState } from "./useAsync.js";

interface ComputeLike {
  name: string;
  provider: string;
  status: string;
  config: Record<string, unknown>;
}

export function useComputeActions(
  asyncState: AsyncState,
  addLog: (name: string, message: string) => void,
) {
  const ark = useArkClient();
  const run = asyncState.run;

  return {
    provision: (compute: ComputeLike) => {
      addLog(compute.name, "Starting provisioning...");
      run(`Provisioning ${compute.name}`, async () => {
        addLog(compute.name, `Provider: ${compute.provider}, size: ${(compute.config as any)?.size ?? "default"}`);
        await ark.computeProvision(compute.name);
        addLog(compute.name, "Provisioning complete");
      });
    },

    stop: (compute: ComputeLike) => {
      addLog(compute.name, "Stopping...");
      run(`Stopping ${compute.name}`, async () => {
        try {
          await ark.computeStopInstance(compute.name);
          addLog(compute.name, "Stopped");
        } catch (e: any) {
          addLog(compute.name, `Stop failed: ${e?.message ?? e}`);
          throw e;
        }
      });
    },

    start: (compute: ComputeLike) => {
      addLog(compute.name, "Starting...");
      run(`Starting ${compute.name}`, async () => {
        await ark.computeStartInstance(compute.name);
        addLog(compute.name, "Started");
      });
    },

    delete: (name: string) => {
      run(`Deleting ${name}`, async () => {
        try { await ark.computeStopInstance(name); } catch { /* may already be gone */ }
        await ark.computeDelete(name);
      });
    },

    reboot: (compute: ComputeLike) => {
      addLog(compute.name, "Rebooting...");
      run(`Rebooting ${compute.name}`, async () => {
        await ark.computeReboot(compute.name);
        addLog(compute.name, "Reboot complete");
      });
    },

    ping: (compute: ComputeLike) => {
      const cfg = compute.config as any;
      const ip = cfg?.ip;
      if (!ip) { addLog(compute.name, "Local — always available"); return; }
      addLog(compute.name, `Checking connectivity to ${ip}...`);
      run(`Pinging ${compute.name}`, async () => {
        const result = await ark.computePing(compute.name);
        addLog(compute.name, result.reachable ? `Reachable — ${result.message}` : result.message);
      });
    },

    clean: () => {
      run("Cleaning zombie sessions", async () => {
        const result = await ark.computeCleanZombies();
        addLog("local", result.cleaned > 0 ? `Killed ${result.cleaned} zombie(s)` : "No zombies found");
      });
    },
  };
}

/**
 * Central compute action dispatcher. Every mutation goes through
 * asyncState.run() which automatically refreshes via onComplete.
 */

import * as core from "../../core/index.js";
import { getProvider } from "../../compute/index.js";
import type { AsyncState } from "./useAsync.js";

export function useComputeActions(
  asyncState: AsyncState,
  addLog: (name: string, message: string) => void,
) {
  const run = asyncState.run;

  return {
    provision: (compute: core.Compute) => {
      const provider = getProvider(compute.provider);
      if (!provider) return;

      addLog(compute.name, "Starting provisioning...");
      core.updateCompute(compute.name, { status: "provisioning" });

      run(`Provisioning ${compute.name}`, async () => {
        addLog(compute.name, `Provider: ${compute.provider}, size: ${(compute.config as any)?.size ?? "default"}`);
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Provisioning timed out after 20 minutes")), 1_200_000)
        );
        await Promise.race([
          provider.provision(compute, {
            onLog: (msg: string) => addLog(compute.name, msg),
          }),
          timeout,
        ]);
        core.updateCompute(compute.name, { status: "running" });
        addLog(compute.name, "Provisioning complete");
      });
    },

    stop: (compute: core.Compute) => {
      const provider = getProvider(compute.provider);
      if (!provider) return;
      addLog(compute.name, "Stopping...");
      run(`Stopping ${compute.name}`, async () => {
        await provider.stop(compute);
        core.updateCompute(compute.name, { status: "stopped" });
        addLog(compute.name, "Stopped");
      });
    },

    start: (compute: core.Compute) => {
      const provider = getProvider(compute.provider);
      if (!provider) return;
      addLog(compute.name, "Starting...");
      run(`Starting ${compute.name}`, async () => {
        await provider.start(compute);
        core.updateCompute(compute.name, { status: "running" });
        addLog(compute.name, "Started");
      });
    },

    delete: (name: string) => {
      run(`Deleting ${name}`, () => { core.deleteCompute(name); });
    },

    clean: () => {
      run("Cleaning zombie sessions", async () => {
        const { listArkSessionsAsync, killSessionAsync } = await import("../../core/tmux.js");
        const tmuxSessions = await listArkSessionsAsync();
        let cleaned = 0;
        for (const ts of tmuxSessions) {
          const sessionId = ts.name.replace("ark-", "");
          const dbSession = core.getSession(sessionId);
          if (!dbSession || ["failed", "completed"].includes(dbSession.status)) {
            await killSessionAsync(ts.name);
            if (dbSession) core.updateSession(dbSession.id, { session_id: null });
            cleaned++;
          }
        }
        addLog("local", cleaned > 0 ? `Killed ${cleaned} zombie(s)` : "No zombies found");
      });
    },
  };
}

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
        try {
          await provider.stop(compute);
          core.updateCompute(compute.name, { status: "stopped" });
          addLog(compute.name, "Stopped");
        } catch (e: any) {
          // Instance may already be terminated externally — check real status
          if (provider.checkStatus) {
            const real = await provider.checkStatus(compute).catch(() => null);
            if (real === "destroyed" || real === "terminated") {
              core.updateCompute(compute.name, { status: "destroyed" });
              core.mergeComputeConfig(compute.name, { ip: null });
              addLog(compute.name, "Instance no longer exists — marked as destroyed");
              return;
            }
          }
          addLog(compute.name, `Stop failed: ${e?.message ?? e}`);
          throw e;
        }
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
      run(`Deleting ${name}`, async () => {
        const compute = core.getCompute(name);
        if (compute) {
          const provider = getProvider(compute.provider);
          if (provider) {
            try { await provider.stop(compute); } catch (e: any) { console.error(`compute delete: stop failed (may already be gone):`, e?.message ?? e); }
          }
        }
        core.deleteCompute(name);
      });
    },

    reboot: (compute: core.Compute) => {
      const provider = getProvider(compute.provider);
      if (!provider?.canReboot) return;
      const cfg = compute.config as any;
      if (!cfg?.instance_id) return;
      addLog(compute.name, "Rebooting...");
      run(`Rebooting ${compute.name}`, async (updateLabel) => {
        const { EC2Client, RebootInstancesCommand, DescribeInstancesCommand } = await import("@aws-sdk/client-ec2");
        const { fromIni } = await import("@aws-sdk/credential-providers");
        const { sshExecAsync, sshKeyPath } = await import("../../compute/providers/ec2/ssh.js");

        const ec2 = new EC2Client({
          region: cfg.region ?? "us-east-1",
          ...(cfg.aws_profile ? { credentials: fromIni({ profile: cfg.aws_profile }) } : {}),
        });
        await ec2.send(new RebootInstancesCommand({ InstanceIds: [cfg.instance_id] }));
        addLog(compute.name, "Reboot initiated — waiting for host...");

        // Wait up to 3 minutes for SSH to come back
        const deadline = Date.now() + 180_000;
        let attempt = 0;
        while (Date.now() < deadline) {
          attempt++;
          updateLabel(`Rebooting ${compute.name} (${attempt}...)`);
          await new Promise(r => setTimeout(r, 10_000));

          // Check if IP changed (stop/start assigns new IP)
          const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [cfg.instance_id] }));
          const inst = desc.Reservations?.[0]?.Instances?.[0];
          const newIp = inst?.PublicIpAddress;
          if (newIp && newIp !== cfg.ip) {
            core.mergeComputeConfig(compute.name, { ip: newIp });
            addLog(compute.name, `IP changed: ${cfg.ip} → ${newIp}`);
            cfg.ip = newIp;
          }

          if (!cfg.ip) continue;
          const { exitCode } = await sshExecAsync(sshKeyPath(compute.name), cfg.ip, "echo ok", { timeout: 10_000 });
          if (exitCode === 0) {
            addLog(compute.name, "Host is back online");
            core.updateCompute(compute.name, { status: "running" });
            return;
          }
        }

        // Timed out
        addLog(compute.name, "Host did not come back after 3 minutes");
        core.updateCompute(compute.name, { status: "stopped" });
        core.mergeComputeConfig(compute.name, { last_error: "Reboot timeout — host unreachable" });
      });
    },

    ping: (compute: core.Compute) => {
      if (!getProvider(compute.provider)?.canReboot) {
        addLog(compute.name, "Local — always available");
        return;
      }
      const cfg = compute.config as any;
      const ip = cfg?.ip;
      if (!ip) { addLog(compute.name, "No IP configured"); return; }
      addLog(compute.name, `Checking connectivity to ${ip}...`);
      run(`Pinging ${compute.name}`, async () => {
        const { sshExecAsync, sshKeyPath } = await import("../../compute/providers/ec2/ssh.js");
        const { exitCode, stdout } = await sshExecAsync(sshKeyPath(compute.name), ip, "echo ok && uptime", { timeout: 10_000 });
        if (exitCode === 0) {
          addLog(compute.name, `Reachable — ${stdout.trim()}`);
        } else {
          addLog(compute.name, "Unreachable — SSH connection failed");
          // Check real AWS status
          const provider = getProvider(compute.provider);
          if (provider?.checkStatus) {
            const real = await provider.checkStatus(compute).catch(() => null);
            if (real) {
              addLog(compute.name, `AWS status: ${real}`);
              if (real !== compute.status) {
                core.updateCompute(compute.name, { status: real });
              }
            }
          }
        }
      });
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

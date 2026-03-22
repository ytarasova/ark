import * as core from "../../core/index.js";
import { getProvider } from "../../compute/index.js";
import { state, addHostLog, selectedHost } from "../state.js";
import { screen, statusBar } from "../layout.js";
import { renderAll } from "../render/index.js";
import { showNewHostForm } from "../forms/new-host.js";
import { selectOne } from "../forms/select.js";
import { createPrompt, askInput } from "../forms/prompt.js";

export function registerHostActions() {
  screen.key(["enter"], () => {
    if (state.tab === "hosts") {
      const h = selectedHost();
      if (!h) return;
      const provider = getProvider(h.provider);
      if (!provider) return;
      if (h.status === "stopped" || h.status === "destroyed") {
        (async () => {
          try {
            addHostLog(h.name, "Starting provisioning...");
            core.updateHost(h.name, { status: "provisioning" });
            renderAll();

            addHostLog(h.name, `Provider: ${h.provider}, size: ${(h.config as any)?.size ?? "default"}`);
            renderAll();

            // Provision with 20-minute timeout (Pulumi + SSH + cloud-init can take 15+ min)
            const timeout = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Provisioning timed out after 20 minutes")), 1_200_000)
            );

            await Promise.race([
              provider.provision(h, {
                onLog: (msg: string) => {
                  addHostLog(h.name, msg);
                  renderAll();
                },
              }),
              timeout,
            ]);

            core.updateHost(h.name, { status: "running" });
            addHostLog(h.name, "Provisioning complete - host is running");
          } catch (e: any) {
            const errMsg = e.message ?? String(e);
            // Persist error to DB so it survives TUI restart
            core.updateHost(h.name, { status: "stopped" });
            core.mergeHostConfig(h.name, { last_error: errMsg });
            addHostLog(h.name, `FAILED: ${errMsg}`);
          }
          renderAll();
        })();
      }
    }
  });

  screen.key(["s"], () => {
    if (state.tab === "hosts") {
      const h = selectedHost();
      if (!h) return;
      const provider = getProvider(h.provider);
      if (!provider) return;
      (async () => {
        try {
          if (h.status === "running") {
            addHostLog(h.name, "Stopping host...");
            renderAll();
            await provider.stop(h);
            core.updateHost(h.name, { status: "stopped" });
            addHostLog(h.name, "Host stopped");
          } else if (h.status === "stopped") {
            addHostLog(h.name, "Starting host...");
            renderAll();
            await provider.start(h);
            core.updateHost(h.name, { status: "running" });
            addHostLog(h.name, "Host started");
          }
        } catch (e: any) {
          addHostLog(h.name, `Failed: ${e.message ?? e}`);
        }
        renderAll();
      })();
    }
  });

  screen.key(["S-s"], () => {
    if (state.tab === "hosts") {
      const h = selectedHost();
      if (!h || h.status !== "running") return;
      const provider = getProvider(h.provider);
      if (!provider) return;
      (async () => {
        try {
          addHostLog(h.name, "Syncing environment...");
          renderAll();
          await provider.syncEnvironment(h, { direction: "push" });
          addHostLog(h.name, "Sync complete");
        } catch (e: any) {
          addHostLog(h.name, `Sync failed: ${e.message ?? e}`);
        }
        renderAll();
      })();
    }
  });

  screen.key(["e"], () => {
    if (state.tab !== "hosts") return;
    const h = selectedHost();
    if (!h) return;

    const prompt = createPrompt();

    const ask = (question: string, defaultVal: string) =>
      askInput(prompt, `Edit ${h.name}`, question, defaultVal);

    (async () => {
      const fields = [
        "size", "arch", "region", "aws_profile", "subnet_id",
        "ingress_cidrs", "idle_minutes", "Cancel",
      ];
      const field = await selectOne("Edit field", fields, 0);
      if (!field || field === "Cancel") { prompt.destroy(); renderAll(); return; }

      const cfg = h.config as any;
      const current = cfg[field] !== undefined ? String(cfg[field]) : "";
      const newVal = await ask(`${field}:`, current);

      if (newVal !== null && newVal !== current) {
        let parsed: any = newVal;
        if (field === "ingress_cidrs") {
          parsed = newVal === "open" ? ["0.0.0.0/0"] : newVal.split(",").map((s: string) => s.trim());
        } else if (field === "idle_minutes") {
          parsed = parseInt(newVal) || 60;
        }
        core.updateHost(h.name, { config: { ...cfg, [field]: parsed } });
        addHostLog(h.name, `Config updated: ${field} = ${JSON.stringify(parsed)}`);
      }
      prompt.destroy();
      renderAll();
    })();
  });

  screen.key(["x"], () => {
    if (state.tab !== "hosts") return;
    const h = selectedHost();
    if (!h) return;
    // Only allow delete on fully stopped/destroyed hosts
    if (h.status !== "stopped" && h.status !== "destroyed") {
      addHostLog(h.name, `Cannot delete: host is ${h.status}`);
      renderAll();
      return;
    }
    // Require confirmation - show in status bar
    statusBar.setContent(`{red-fg} Delete host '${h.name}'? Press x again to confirm, any other key to cancel{/red-fg}`);
    screen.render();
    screen.onceKey(["x"], () => {
      core.deleteHost(h.name);
      if (state.sel > 0) state.sel--;
      renderAll();
    });
  });

  screen.key(["n"], () => {
    if (state.tab === "hosts") {
      showNewHostForm();
    }
  });
}

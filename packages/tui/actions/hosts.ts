import * as core from "../../core/index.js";
import { getProvider } from "../../compute/index.js";
import { state, addHostLog } from "../state.js";
import { screen } from "../layout.js";
import { renderAll } from "../render/index.js";
import { showNewHostForm } from "../forms/new-host.js";

export function registerHostActions() {
  screen.key(["enter"], () => {
    if (state.tab === "hosts") {
      const h = state.hosts[state.sel];
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

            await provider.provision(h, {
              onLog: (msg: string) => {
                addHostLog(h.name, msg);
                renderAll();
              },
            });

            core.updateHost(h.name, { status: "running" });
            addHostLog(h.name, "Provisioning complete — host is running");
          } catch (e: any) {
            core.updateHost(h.name, { status: "stopped" });
            addHostLog(h.name, `Provisioning failed: ${e.message ?? e}`);
          }
          renderAll();
        })();
      }
    }
  });

  screen.key(["s"], () => {
    if (state.tab === "hosts") {
      const h = state.hosts[state.sel];
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
      const h = state.hosts[state.sel];
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

  screen.key(["x"], () => {
    if (state.tab !== "hosts") return;
    const h = state.hosts[state.sel];
    if (!h) return;
    // Only allow delete on stopped or destroyed hosts — never running or provisioning
    if (h.status !== "stopped" && h.status !== "destroyed") return;
    core.deleteHost(h.name);
    if (state.sel > 0) state.sel--;
    addHostLog(h.name, "Host deleted");
    renderAll();
  });

  screen.key(["n"], () => {
    if (state.tab === "hosts") {
      showNewHostForm();
    }
  });
}

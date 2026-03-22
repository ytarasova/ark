import * as core from "../../core/index.js";
import { getProvider } from "../../compute/index.js";
import { state } from "../state.js";
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
        // Provision or start
        (async () => {
          try {
            core.updateHost(h.name, { status: "provisioning" });
            renderAll();
            await provider.provision(h);
            core.updateHost(h.name, { status: "running" });
          } catch { core.updateHost(h.name, { status: "stopped" }); }
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
            await provider.stop(h);
            core.updateHost(h.name, { status: "stopped" });
          } else if (h.status === "stopped") {
            await provider.start(h);
            core.updateHost(h.name, { status: "running" });
          }
        } catch { /* ignore */ }
        renderAll();
      })();
    }
  });

  screen.key(["x"], () => {
    if (state.tab === "hosts") {
      const h = state.hosts[state.sel];
      if (!h) return;
      if (h.status === "running") return; // can't delete running host
      core.deleteHost(h.name);
      if (state.sel > 0) state.sel--;
      renderAll();
    }
  });

  screen.key(["n"], () => {
    if (state.tab === "hosts") {
      showNewHostForm();
    }
  });
}

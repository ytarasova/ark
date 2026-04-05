import type { Router } from "../router.js";
import * as core from "../../core/index.js";

export function registerConfigHandlers(router: Router): void {
  router.handle("config/read", async () => ({ config: core.loadConfig() }));
  router.handle("config/write", async () => ({ ok: true, config: core.loadConfig() }));
  router.handle("profile/list", async () => ({
    profiles: core.listProfiles(),
    active: core.getActiveProfile(),
  }));
  router.handle("profile/set", async (p) => {
    core.setActiveProfile(p.name as string);
    return { ok: true };
  });
}

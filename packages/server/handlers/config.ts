import type { Router } from "../router.js";
import * as core from "../../core/index.js";

export function registerConfigHandlers(router: Router): void {
  router.handle("config/read", async () => ({ config: core.loadConfig() }));
  router.handle("config/write", async () => {
    throw Object.assign(new Error("config/write not yet implemented — edit ~/.ark/config.yaml directly"), { code: -32601 });
  });
  router.handle("profile/list", async () => ({
    profiles: core.listProfiles(),
    active: core.getActiveProfile(),
  }));
  router.handle("profile/set", async (p) => {
    core.setActiveProfile(p.name as string);
    return { ok: true };
  });

  router.handle("profile/create", async (p) => {
    const profile = core.createProfile(p.name as string, p.description as string | undefined);
    return { profile };
  });

  router.handle("profile/delete", async (p) => {
    core.deleteProfile(p.name as string);
    return { ok: true };
  });
}

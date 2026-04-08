import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import * as core from "../../core/index.js";
import { RpcError } from "../../protocol/types.js";
import type {
  ProfileSetParams,
  ProfileCreateParams,
  ProfileDeleteParams,
} from "../../types/index.js";

export function registerConfigHandlers(router: Router, app: AppContext): void {
  router.handle("config/read", async () => ({ config: core.loadConfig() }));
  router.handle("config/write", async () => {
    throw new RpcError("config/write not yet implemented -- edit ~/.ark/config.yaml directly", -32601);
  });
  router.handle("profile/list", async () => ({
    profiles: core.listProfiles(),
    active: core.getActiveProfile(),
  }));
  router.handle("profile/set", async (p) => {
    const { name } = extract<ProfileSetParams>(p, ["name"]);
    core.setActiveProfile(name);
    return { ok: true };
  });

  router.handle("profile/create", async (p) => {
    const { name, description } = extract<ProfileCreateParams>(p, ["name"]);
    const profile = core.createProfile(name, description);
    return { profile };
  });

  router.handle("profile/delete", async (p) => {
    const { name } = extract<ProfileDeleteParams>(p, ["name"]);
    core.deleteProfile(name);
    return { ok: true };
  });
}

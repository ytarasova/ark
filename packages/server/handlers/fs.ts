/**
 * Filesystem handlers -- exposes local directory listings to the web UI so the
 * "New Session" modal can offer a folder picker. READ-ONLY.
 *
 * Local-mode-only: registered via `registerLocalOnlyHandlers`, not called at
 * all in hosted deployments. The handler body never inspects a mode flag.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { RpcError } from "../../protocol/types.js";

interface ListDirParams {
  path?: string;
}

export function registerFsHandlers(router: Router, app: AppContext): void {
  const fs = app.mode.fsCapability;
  // Defensive: we only get here in local mode, where fsCapability is non-null.
  // In hosted mode this handler module isn't registered (see register.ts).
  if (!fs) {
    throw new Error("fsCapability is required to register fs handlers");
  }

  router.handle("fs/list-dir", async (p) => {
    const params = (p ?? {}) as ListDirParams;
    try {
      return await fs.listDir(params.path ?? "");
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError((err as Error).message ?? String(err), -32602);
    }
  });
}

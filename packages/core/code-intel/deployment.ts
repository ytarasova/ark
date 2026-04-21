/**
 * Deployment factory -- builds a Deployment bag from an AppContext.
 *
 * Reads deployment shape from `app.mode` rather than re-sniffing the raw
 * config URL. The `buildAppMode` factory is the single place that converts
 * `databaseUrl` into `mode.database.dialect` + `mode.kind`; every other
 * module (including this one) takes the result.
 *
 * Local profile (Wave 1 default):
 *   SQLite + filesystem vendor + local subprocess + ~/.ark/code-intel
 *   + allow-all policy + stderr observability.
 *
 * Control-plane profile (Wave 3+ swap-ins):
 *   Postgres + in-image vendor + arkd-RPC executor + PVC/S3 storage
 *   + RLS policy + OTLP observability.
 */

import type { AppContext } from "../app.js";
import type { Deployment } from "./interfaces/deployment.js";
import { FilesystemVendorResolver } from "./vendor.js";
import { LocalBinaryExecutor } from "./executor/local.js";
import { LocalRepoStorage } from "./storage/local-fs.js";
import { AllowAllPolicy } from "./policy/allow-all.js";
import { StderrObservability } from "./observability/stderr.js";

export function buildDeployment(app: AppContext): Deployment {
  const mode: Deployment["mode"] = app.mode.kind === "hosted" ? "control-plane" : "local";
  const storeBackend = app.mode.database.dialect;

  const vendorResolver = new FilesystemVendorResolver();
  const arkDir = app.config.arkDir ?? app.config.dirs?.ark ?? process.cwd();
  return {
    mode,
    storeBackend,
    vendorResolver,
    executor: new LocalBinaryExecutor(vendorResolver),
    storage: new LocalRepoStorage(arkDir),
    policy: new AllowAllPolicy(),
    observability: new StderrObservability(),
  };
}

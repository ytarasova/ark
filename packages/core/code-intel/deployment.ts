/**
 * Deployment factory -- builds a Deployment bag from an AppContext.
 *
 * This is the ONE place where the local-vs-control-plane split is
 * decided. Every other module (extractors, queries, pipeline, store)
 * takes a `Deployment` and is mode-agnostic.
 *
 * Local profile (Wave 1 default):
 *   SQLite + filesystem vendor + local subprocess + ~/.ark/code-intel
 *   + allow-all policy + stderr observability.
 *
 * Control-plane profile (Wave 3+ swap-ins):
 *   Postgres + in-image vendor + arkd-RPC executor + PVC/S3 storage
 *   + RLS policy + OTLP observability.
 *
 * The factory detects mode from `app.config.profile` and from
 * `app.config.database.url` (presence of postgres:// implies hosted,
 * even if profile was left as `local` for some reason).
 */

import type { AppContext } from "../app.js";
import type { Deployment } from "./interfaces/deployment.js";
import { FilesystemVendorResolver } from "./vendor.js";
import { LocalBinaryExecutor } from "./executor/local.js";
import { LocalRepoStorage } from "./storage/local-fs.js";
import { AllowAllPolicy } from "./policy/allow-all.js";
import { StderrObservability } from "./observability/stderr.js";

export function buildDeployment(app: AppContext): Deployment {
  const url = app.config.database?.url ?? app.config.databaseUrl;
  const isPostgres = !!url && (url.startsWith("postgres://") || url.startsWith("postgresql://"));
  const profile = app.config.profile;
  const mode: Deployment["mode"] = profile === "control-plane" || isPostgres ? "control-plane" : "local";

  const vendorResolver = new FilesystemVendorResolver();
  const arkDir = app.config.arkDir ?? app.config.dirs?.ark ?? process.cwd();
  return {
    mode,
    storeBackend: isPostgres ? "postgres" : "sqlite",
    vendorResolver,
    executor: new LocalBinaryExecutor(vendorResolver),
    storage: new LocalRepoStorage(arkDir),
    policy: new AllowAllPolicy(),
    observability: new StderrObservability(),
  };
}

/**
 * Deployment factory -- pick the right Deployment from an AppContext.
 *
 * Local profile -> SQLite + filesystem vendor resolver.
 * Control-plane profile -> Postgres + filesystem vendor resolver
 *   (in-image binaries; resolver still walks the filesystem to find them).
 *
 * The Deployment is a thin facade: it tells the rest of the code which
 * dialect to write SQL for and where to find binaries. Single source of
 * truth for the local-vs-hosted split.
 */

import type { AppContext } from "../app.js";
import type { Deployment } from "./interfaces/deployment.js";
import { FilesystemVendorResolver } from "./vendor.js";

export function buildDeployment(app: AppContext): Deployment {
  const url = app.config.database?.url ?? app.config.databaseUrl;
  const isPostgres = !!url && (url.startsWith("postgres://") || url.startsWith("postgresql://"));
  const profile = app.config.profile;
  const mode: Deployment["mode"] = profile === "control-plane" || isPostgres ? "control-plane" : "local";
  return {
    mode,
    storeBackend: isPostgres ? "postgres" : "sqlite",
    vendorResolver: new FilesystemVendorResolver(),
  };
}

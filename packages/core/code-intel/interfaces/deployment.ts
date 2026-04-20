/**
 * Deployment -- the bag of mode-specific behaviors the rest of the code
 * reads when it needs to know "local vs control-plane".
 *
 * Phase 1 resolves a Deployment from `app.config.profile`. Every extractor
 * and query method reads deployment-mode behavior through this interface,
 * so the only place "local vs hosted" diverges is deployment wiring itself.
 *
 * Example:
 *   const deployment: Deployment = {
 *     mode: "local",
 *     storeBackend: "sqlite",
 *     vendorResolver: new FilesystemVendorResolver(),
 *   };
 */

import type { VendorResolver } from "./vendor.js";

export interface Deployment {
  mode: "local" | "control-plane";
  storeBackend: "sqlite" | "postgres";
  vendorResolver: VendorResolver;
}

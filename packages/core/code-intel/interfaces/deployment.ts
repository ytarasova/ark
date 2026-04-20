/**
 * Deployment -- the bag of mode-specific behaviors the rest of the code
 * reads when it needs to know "local vs control-plane".
 *
 * Every extractor / query / pipeline call reads mode-specific behavior
 * through this one interface. The ONLY place "local vs hosted" diverges
 * is the factory that builds a Deployment; once built, downstream code
 * is mode-agnostic.
 *
 * Local defaults (Wave 1):
 *   - storeBackend: sqlite
 *   - vendorResolver: FilesystemVendorResolver (~/.ark, $PATH fallback)
 *   - executor: LocalBinaryExecutor (Bun subprocess)
 *   - storage: LocalRepoStorage (~/.ark/code-intel/...)
 *   - policy: AllowAllPolicy (D12 replaces)
 *   - observability: StderrObservability (structured log lines)
 *
 * Control-plane swap-ins (landing in Wave 3+):
 *   - storeBackend: postgres
 *   - vendorResolver: in-image (same FilesystemVendorResolver, different root)
 *   - executor: ArkdBinaryExecutor (RPC to tenant's arkd worker pool)
 *   - storage: PvcRepoStorage / S3RepoStorage
 *   - policy: RowLevelSecurityPolicy (Postgres RLS + redaction rules)
 *   - observability: OtlpObservability (OTLP spans + Prometheus counters)
 */

import type { VendorResolver } from "./vendor.js";
import type { BinaryExecutor } from "./executor.js";
import type { RepoStorage } from "./storage.js";
import type { Policy } from "./policy.js";
import type { Observability } from "./observability.js";

export interface Deployment {
  mode: "local" | "control-plane";
  storeBackend: "sqlite" | "postgres";
  vendorResolver: VendorResolver;
  executor: BinaryExecutor;
  storage: RepoStorage;
  policy: Policy;
  observability: Observability;
}

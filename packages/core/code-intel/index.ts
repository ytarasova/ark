/**
 * Code-intel barrel -- re-exports the public Wave 1 surface.
 *
 * External consumers should import from this module, not from individual
 * subpaths, so internal restructuring stays cheap.
 */

export { CodeIntelStore, DEFAULT_TENANT_ID } from "./store.js";
export type {
  Tenant,
  Repo as StoredRepo,
  IndexingRun as StoredIndexingRun,
  FileRow,
  SymbolRow,
  ChunkRow,
  EdgeRow,
  ExternalRefRow,
  EmbeddingRow,
  DependencyRow,
  PersonRow,
  ContributionRow,
  HotspotRow,
} from "./store.js";

export { MigrationRunner } from "./migration-runner.js";
export { FilesystemVendorResolver } from "./vendor.js";
export { buildDeployment } from "./deployment.js";
export { CodeIntelPipeline } from "./pipeline.js";
export { AllowAllPolicy } from "./policy/allow-all.js";
export { WAVE1_EXTRACTORS } from "./extractors/index.js";
export { buildDefaultRegistry } from "./queries/index.js";
export * from "./interfaces/index.js";

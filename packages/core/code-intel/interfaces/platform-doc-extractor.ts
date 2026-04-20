/**
 * PlatformDocExtractor -- cousin of Extractor that emits one cross-repo
 * synthesis document per workspace instead of per-row table data.
 *
 * Where `Extractor` streams chunks/symbols/files into per-repo tables, a
 * PlatformDocExtractor takes a whole workspace, reads from those tables via
 * the store, and renders a Markdown document that the caller persists via
 * `upsertPlatformDoc`. Three flavors exist in the plan -- only `mechanical`
 * (pure query + template) lands in Wave 2c; `llm` + `hybrid` land in Waves
 * 4 and 5 on the exact same interface.
 *
 * Example (Wave 2c mechanical):
 *
 *   const serviceDependencyGraph: PlatformDocExtractor = {
 *     doc_type: "service_dependency_graph",
 *     flavor: "mechanical",
 *     cadence: "on_reindex",
 *     async generate(ctx, workspace_id) {
 *       const deps = ...;
 *       return { title: "Service Dependency Graph", content_md: "```mermaid\n..." };
 *     },
 *   };
 */

import type { CodeIntelStore } from "../store.js";

/** Synthesis flavor for a platform doc. Mirrors the schema column. */
export type PlatformDocFlavor = "mechanical" | "llm" | "hybrid";

/**
 * When the extractor runs. `on_reindex` wires up to the end of a workspace
 * reindex, `daily`/`weekly` run under the trigger framework, `on_demand`
 * only fires from CLI/UI, and `off` disables the extractor (kept registered
 * so regen commands can still target it explicitly).
 */
export type PlatformDocCadence = "on_reindex" | "daily" | "weekly" | "on_demand" | "off";

/**
 * Execution context handed to a platform-doc extractor. Kept minimal so
 * Wave 4 LLM extractors can wrap it with a higher-level wrapper (adding
 * model handles, budget trackers, etc.) without touching Wave 2c code.
 */
export interface PlatformDocContext {
  /** Tenant that owns the workspace (belt-and-braces query scoping). */
  tenant_id: string;
  /** The workspace-scoped store. Extractors use this to read data. */
  store: CodeIntelStore;
  /** Optional indexing run id that triggered this generation. */
  run_id?: string | null;
}

/**
 * Shape emitted by a PlatformDocExtractor. The caller (generator) is
 * responsible for persisting this via `upsertPlatformDoc`; the extractor
 * itself never touches the DB write path.
 */
export interface PlatformDocInput {
  /** Human-readable title shown in the CLI/UI. */
  title: string;
  /** Full markdown body. May include embedded code blocks (e.g. mermaid). */
  content_md: string;
  /** Free-form provenance blob persisted alongside the doc. */
  source?: Record<string, unknown>;
}

export interface PlatformDocExtractor {
  /** Stable doc-type key. Unique per workspace (per the schema UNIQUE index). */
  readonly doc_type: string;
  /** Synthesis flavor (mechanical / llm / hybrid). */
  readonly flavor: PlatformDocFlavor;
  /** When this extractor runs. See `PlatformDocCadence`. */
  readonly cadence: PlatformDocCadence;
  /** Render one markdown doc for the given workspace. */
  generate(ctx: PlatformDocContext, workspace_id: string): Promise<PlatformDocInput>;
}

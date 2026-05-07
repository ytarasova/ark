/**
 * Workspace manifest -- YAML descriptor dropped at the root of a
 * workspace-scoped session workdir (Wave 2b-1).
 *
 * Shape:
 *
 *   session_id: s-xyzabc123
 *   workspace_id: ws-...
 *   primary_repo_id: r-...       # optional
 *   created_at: 2026-04-20T...
 *   repos:
 *     - repo_id: r-...
 *       slug: payment-service
 *       local_path: /abs/path/inside/workdir
 *       branch: ark/sess-xyzabc
 *       commit: null              # populated after clone
 *       cloned: false
 *
 * Lives at `<workdir>/.ark-workspace.yaml`. `ensureRepoCloned` flips
 * `cloned: true` (and stamps the commit sha) on first-touch clone so
 * downstream code can cheaply tell what's already on disk.
 *
 * LOCAL compute only for Wave 2b-1. Remote compute targets read the
 * manifest from their own copy of the workdir in Wave 2b-2; the schema
 * is deliberately portable (no local-only fields).
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";

/** One repo entry inside a workspace manifest. */
export interface WorkspaceManifestRepo {
  /** FK to `workspace_repos.id`. */
  repo_id: string;
  /** Directory name under the session workdir (= the repo's slug/name). */
  slug: string;
  /** Absolute path the sparse provisioner will clone into. Stable across calls. */
  local_path: string;
  /** Session branch this repo lives on (`ark/sess-<short>` + optional suffix). */
  branch: string;
  /** Commit sha recorded after clone; null until first-touch. */
  commit: string | null;
  /** True once the repo has been materialised on disk. */
  cloned: boolean;
}

/** Top-level manifest. Serialised as YAML to `.ark-workspace.yaml`. */
export interface WorkspaceManifest {
  /** Ark session id (also the workdir leaf under `~/.ark/workspaces/`). */
  session_id: string;
  /** FK to `workspaces.id`. */
  workspace_id: string;
  /** Every repo in the workspace at session creation time. */
  repos: WorkspaceManifestRepo[];
  /** Optional primary entry-point repo (set when `--repo <slug>` accompanies `--workspace`). */
  primary_repo_id?: string | null;
  /** ISO timestamp stamped at creation. */
  created_at: string;
}

export const MANIFEST_FILENAME = ".ark-workspace.yaml";

/** Resolve the manifest path for a workdir. Does not touch the filesystem. */
export function manifestPath(workdir: string): string {
  return join(workdir, MANIFEST_FILENAME);
}

/**
 * Validate a manifest's required fields + internal shape. Throws a
 * descriptive error so provisioner / dispatch code fails loudly on a
 * corrupted or hand-edited file rather than silently ignoring bad data.
 */
export function validateManifest(m: unknown): asserts m is WorkspaceManifest {
  if (!m || typeof m !== "object") {
    throw new Error("workspace manifest must be an object");
  }
  const mf = m as Record<string, unknown>;
  if (typeof mf.session_id !== "string" || mf.session_id.length === 0) {
    throw new Error("workspace manifest: session_id must be a non-empty string");
  }
  if (typeof mf.workspace_id !== "string" || mf.workspace_id.length === 0) {
    throw new Error("workspace manifest: workspace_id must be a non-empty string");
  }
  if (typeof mf.created_at !== "string" || mf.created_at.length === 0) {
    throw new Error("workspace manifest: created_at must be a non-empty string");
  }
  if (!Array.isArray(mf.repos)) {
    throw new Error("workspace manifest: repos must be an array");
  }
  for (const [i, entry] of (mf.repos as unknown[]).entries()) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`workspace manifest: repos[${i}] must be an object`);
    }
    const r = entry as Record<string, unknown>;
    for (const k of ["repo_id", "slug", "local_path", "branch"]) {
      if (typeof r[k] !== "string" || (r[k] as string).length === 0) {
        throw new Error(`workspace manifest: repos[${i}].${k} must be a non-empty string`);
      }
    }
    if (typeof r.cloned !== "boolean") {
      throw new Error(`workspace manifest: repos[${i}].cloned must be a boolean`);
    }
    if (r.commit !== null && typeof r.commit !== "string") {
      throw new Error(`workspace manifest: repos[${i}].commit must be a string or null`);
    }
  }
  if (mf.primary_repo_id !== undefined && mf.primary_repo_id !== null && typeof mf.primary_repo_id !== "string") {
    throw new Error("workspace manifest: primary_repo_id must be a string, null, or undefined");
  }
}

/**
 * Write `manifest` as YAML to `<workdir>/.ark-workspace.yaml`. Overwrites an
 * existing file. Validates before write so a corrupt object never lands on
 * disk. Returns the absolute path written.
 */
export function writeManifest(workdir: string, manifest: WorkspaceManifest): string {
  validateManifest(manifest);
  const path = manifestPath(workdir);
  const yaml = YAML.stringify(manifest);
  writeFileSync(path, yaml, "utf-8");
  return path;
}

/**
 * Read + parse `<workdir>/.ark-workspace.yaml`. Returns null when the file
 * is absent (not an error -- legacy single-repo sessions have no manifest).
 * Throws on malformed YAML or a shape that fails validation.
 */
export function readManifest(workdir: string): WorkspaceManifest | null {
  const path = manifestPath(workdir);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const parsed = YAML.parse(raw);
  validateManifest(parsed);
  return parsed;
}

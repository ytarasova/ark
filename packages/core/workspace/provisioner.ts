/**
 * Workspace sparse provisioner (Wave 2b-1 -- LOCAL compute only).
 *
 * Two entry points:
 *
 *   1. `provisionWorkspaceWorkdir(app, session, workspace)`
 *        -- creates `~/.ark/workspaces/<session_id>/`
 *        -- writes `.ark-workspace.yaml` listing every repo in the workspace
 *           with `cloned: false`
 *        -- returns the parent workdir path
 *      No repos are touched on disk at this stage -- onboarding is fast even
 *      for large workspaces. First `ensureRepoCloned` call materialises a
 *      repo under `<workdir>/<slug>/`.
 *
 *   2. `ensureRepoCloned(app, session_id, repo_slug)`
 *        -- idempotent: no-op when the repo is already marked `cloned: true`
 *        -- clones from the workspace repo row (prefers `local_path` so
 *           fast-path is a local clone; falls back to `repo_url`)
 *        -- creates a fresh session branch `ark/sess-<short-id>`
 *           - if that branch name already exists in the clone source, we
 *             append a random suffix and emit a warning (never error)
 *        -- flips `cloned: true` + records the commit sha in the manifest
 *
 * Hard scope: LOCAL compute only. Docker / EC2 / K8s / Firecracker / e2b /
 * devcontainer are explicitly Wave 2b-2 and MUST NOT be touched here.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import { execFile } from "child_process";
import { randomBytes } from "crypto";

import type { AppContext } from "../app.js";
import type { Session } from "../../types/index.js";
import type { Repo, Workspace } from "../code-intel/store.js";
import { DEFAULT_TENANT_ID } from "../code-intel/constants.js";
import { logDebug, logInfo, logWarn } from "../observability/structured-log.js";
import {
  MANIFEST_FILENAME,
  manifestPath,
  readManifest,
  writeManifest,
  type WorkspaceManifest,
  type WorkspaceManifestRepo,
} from "./manifest.js";

const execFileAsync = promisify(execFile);

/**
 * Directory under arkDir where workspace-scoped session workdirs live.
 * One leaf per session: `<arkDir>/workspaces/<session_id>/`.
 */
export function workspacesRootDir(app: AppContext): string {
  return join(app.config.arkDir, "workspaces");
}

/** The absolute path for a single workspace-scoped session workdir. */
export function workspaceWorkdir(app: AppContext, sessionId: string): string {
  return join(workspacesRootDir(app), sessionId);
}

/**
 * Branch convention for a workspace session. 10-char id -> short 7 for the
 * branch label; if callers already pass a short id we still slice. The
 * `ark/sess-` prefix keeps everything under one namespace that users can
 * prune with `git branch -D ark/sess-*`.
 */
export function sessionBranchName(sessionId: string): string {
  const short = sessionId.replace(/^s-/, "").slice(0, 7);
  return `ark/sess-${short}`;
}

/** Sanitise a slug so it's safe as a directory name. */
function safeSlug(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-") || "repo";
}

/**
 * Build the initial (pre-clone) manifest rows from the DB repo list.
 * `cloned: false` everywhere -- the caller writes the manifest; downstream
 * `ensureRepoCloned` flips the flag per repo on first touch.
 */
function buildInitialRepoRows(repos: Repo[], sessionId: string, workdir: string): WorkspaceManifestRepo[] {
  const branch = sessionBranchName(sessionId);
  return repos.map((r) => {
    const slug = safeSlug(r.name);
    return {
      repo_id: r.id,
      slug,
      local_path: join(workdir, slug),
      branch,
      commit: null,
      cloned: false,
    };
  });
}

/**
 * Create the workspace-scoped session workdir and drop the initial
 * `.ark-workspace.yaml` manifest. Does NOT clone any repos -- that's
 * deferred to `ensureRepoCloned`.
 *
 * Idempotent: rewriting the manifest when the dir already exists is safe
 * for cases where the caller reruns provisioning (resumed session,
 * interrupted startup, etc.) because we only overwrite `cloned: false`
 * rows. If any repo already has `cloned: true` we preserve that state --
 * otherwise re-provisioning would forget on-disk clones.
 *
 * Returns the absolute workdir path.
 */
export async function provisionWorkspaceWorkdir(
  app: AppContext,
  session: Session,
  workspace: Workspace,
  opts?: { primaryRepoId?: string | null },
): Promise<string> {
  const workdir = workspaceWorkdir(app, session.id);
  mkdirSync(workdir, { recursive: true });

  const repos = await app.codeIntel.listReposInWorkspace(workspace.tenant_id, workspace.id);
  const fresh = buildInitialRepoRows(repos, session.id, workdir);

  // Preserve any existing clone state from a prior provisioning pass.
  const existing = readManifest(workdir);
  const repoRows: WorkspaceManifestRepo[] = fresh.map((row) => {
    const prev = existing?.repos.find((r) => r.repo_id === row.repo_id);
    if (prev && prev.cloned) {
      return { ...row, cloned: true, commit: prev.commit ?? null };
    }
    return row;
  });

  const manifest: WorkspaceManifest = {
    session_id: session.id,
    workspace_id: workspace.id,
    primary_repo_id: opts?.primaryRepoId ?? null,
    repos: repoRows,
    created_at: existing?.created_at ?? new Date().toISOString(),
  };
  writeManifest(workdir, manifest);

  logInfo(
    "workspace",
    `provisioned workspace workdir for session=${session.id} workspace=${workspace.slug} repos=${repoRows.length}`,
  );
  return workdir;
}

// ── branch collision helpers ────────────────────────────────────────────────

/**
 * True when `branch` is a known ref inside `repoDir`. Uses
 * `git show-ref --verify` which exits non-zero on missing refs. Any
 * git failure is treated as "absent" so we never block session startup.
 */
async function branchExists(repoDir: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["-C", repoDir, "show-ref", "--verify", `refs/heads/${branch}`], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * If `baseBranch` already exists at `repoDir`, append a random 4-char
 * suffix and warn. Never errors -- collision is recoverable. Returns the
 * branch name the caller should use.
 */
async function resolveBranchForRepo(repoDir: string, baseBranch: string): Promise<string> {
  if (!(await branchExists(repoDir, baseBranch))) return baseBranch;
  const suffix = randomBytes(2).toString("hex");
  const next = `${baseBranch}-${suffix}`;
  logWarn("workspace", `session branch ${baseBranch} already exists in ${repoDir}; appending random suffix -> ${next}`);
  return next;
}

// ── cloning ────────────────────────────────────────────────────────────────

/**
 * Determine the clone source for a repo row. Prefer `local_path` (fast
 * local clone) over `repo_url` (network). Throws when neither is set --
 * the session should not proceed silently against a ghost repo.
 */
function cloneSourceForRepo(repo: Repo): string {
  if (repo.local_path && existsSync(repo.local_path)) return repo.local_path;
  if (repo.repo_url) return repo.repo_url;
  throw new Error(
    `workspace repo ${repo.id} (${repo.name}) has no local_path or repo_url; cannot clone. ` +
      `Add one via \`ark code-intel repo add\`.`,
  );
}

/**
 * Best-effort read of HEAD commit sha after clone. Returns null when git
 * can't answer (fresh empty repo, shallow clone weirdness, etc.) --
 * callers should not fail provisioning on this.
 */
async function readHeadCommit(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoDir, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      timeout: 5_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Ensure the repo identified by `slug` is cloned under the session's
 * workspace workdir. Idempotent: returns immediately when the manifest
 * already flags the repo as `cloned: true`.
 *
 * On first-touch:
 *   1. Locate the source (`repo.local_path` > `repo.repo_url`).
 *   2. Clone into `<workdir>/<slug>/`.
 *   3. Create `ark/sess-<short>` (with collision-safe suffix) and checkout.
 *   4. Flip `cloned: true` + record the commit sha in the manifest.
 *
 * Errors during clone surface verbatim -- they mean the agent can't work
 * against that repo and the caller should know (no silent fallback).
 */
export async function ensureRepoCloned(
  app: AppContext,
  sessionId: string,
  repoSlug: string,
): Promise<WorkspaceManifestRepo> {
  const workdir = workspaceWorkdir(app, sessionId);
  const manifest = readManifest(workdir);
  if (!manifest) {
    throw new Error(`session ${sessionId} has no workspace manifest at ${manifestPath(workdir)}`);
  }
  const entry = manifest.repos.find((r) => r.slug === repoSlug);
  if (!entry) {
    throw new Error(`workspace manifest for session ${sessionId} has no repo with slug '${repoSlug}'`);
  }
  if (entry.cloned && existsSync(entry.local_path)) {
    logDebug("workspace", `ensureRepoCloned: ${sessionId}/${repoSlug} already cloned`);
    return entry;
  }

  const session = await app.sessions.get(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);
  const tenantId = session.tenant_id ?? DEFAULT_TENANT_ID;

  const repoRow = await app.codeIntel.getRepo(tenantId, entry.repo_id);
  if (!repoRow) {
    throw new Error(
      `workspace repo ${entry.repo_id} (slug=${repoSlug}) missing from code_intel_repos for tenant ${tenantId}`,
    );
  }

  const source = cloneSourceForRepo(repoRow);
  const destination = entry.local_path;
  mkdirSync(workdir, { recursive: true });

  // The destination dir must not already be a populated git checkout --
  // otherwise `git clone` fails and we'd be unable to tell whether the
  // existing tree matches what we want. Clean only empty leftovers so we
  // don't clobber a user-curated tree by accident.
  if (existsSync(destination)) {
    try {
      const entries = readdirSync(destination);
      if (entries.length > 0) {
        // A partial prior clone. Manifest said cloned=false so nuking is
        // correct -- but we guard against parent dir weirdness.
        const stat = statSync(destination);
        if (!stat.isDirectory()) {
          throw new Error(`workspace destination ${destination} exists but is not a directory`);
        }
        logWarn("workspace", `ensureRepoCloned: wiping partial clone at ${destination}`);
        const { rmSync } = await import("fs");
        rmSync(destination, { recursive: true, force: true });
      }
    } catch (e: any) {
      throw new Error(`cannot prepare clone destination ${destination}: ${e?.message ?? e}`);
    }
  }

  logInfo("workspace", `cloning ${source} -> ${destination} (session=${sessionId})`);
  try {
    await execFileAsync("git", ["clone", source, destination], {
      encoding: "utf-8",
      timeout: 300_000,
    });
  } catch (e: any) {
    throw new Error(`failed to clone workspace repo ${repoSlug} from ${source}: ${e?.message ?? e}`);
  }

  const resolvedBranch = await resolveBranchForRepo(destination, entry.branch);
  try {
    await execFileAsync("git", ["-C", destination, "checkout", "-b", resolvedBranch], {
      encoding: "utf-8",
      timeout: 30_000,
    });
  } catch (e: any) {
    // Branch creation shouldn't fail because `resolveBranchForRepo` picked
    // a unique name -- but if it does, surface it rather than silently
    // running the agent on the default branch (cross-session leakage).
    throw new Error(`failed to create session branch '${resolvedBranch}' in ${destination}: ${e?.message ?? e}`);
  }

  const commit = await readHeadCommit(destination);

  // Persist the flipped state. Keep the rest of the manifest untouched so
  // concurrent `ensureRepoCloned` calls for different slugs don't clobber
  // each other's updates -- re-read before write and diff on repo_id.
  const fresh = readManifest(workdir);
  if (!fresh) {
    throw new Error(`workspace manifest vanished while cloning ${repoSlug} for session ${sessionId}`);
  }
  fresh.repos = fresh.repos.map((r) => {
    if (r.repo_id !== entry.repo_id) return r;
    return { ...r, cloned: true, branch: resolvedBranch, commit };
  });
  writeManifest(workdir, fresh);

  return fresh.repos.find((r) => r.repo_id === entry.repo_id)!;
}

/**
 * Convenience: return the on-disk repo slugs for a workspace session,
 * regardless of clone state. Used by executors to populate
 * `ARK_WORKSPACE_REPOS`.
 */
export function listWorkspaceRepoSlugs(app: AppContext, sessionId: string): string[] {
  const workdir = workspaceWorkdir(app, sessionId);
  try {
    const m = readManifest(workdir);
    return m?.repos.map((r) => r.slug) ?? [];
  } catch {
    return [];
  }
}

/** Read the manifest for a session, or null if absent / session not workspace-scoped. */
export function readSessionManifest(app: AppContext, sessionId: string): WorkspaceManifest | null {
  const workdir = workspaceWorkdir(app, sessionId);
  try {
    return readManifest(workdir);
  } catch {
    return null;
  }
}

export { MANIFEST_FILENAME };

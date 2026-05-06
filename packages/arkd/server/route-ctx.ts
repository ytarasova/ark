/**
 * Per-server context shared with all route handlers.
 *
 * `conductorUrl` is a getter/setter because server.ts keeps it as a
 * mutable `let` that can be updated at runtime via POST /config or
 * setConductorUrl() on the returned handle.
 */

export interface ArkdOpts {
  quiet?: boolean;
  conductorUrl?: string;
  hostname?: string;
  /** Bearer token for auth. Overrides ARK_ARKD_TOKEN env var. */
  token?: string;
  /**
   * Filesystem root that every /file/* and /exec request is confined to.
   * Required in hosted / untrusted contexts; when unset, /file/* and
   * /exec accept absolute paths from any caller and trust the bearer
   * token for full host FS access -- acceptable only for local-single-user
   * mode, which is the historical behavior retained for backward compat.
   */
  workspaceRoot?: string;
}

export interface RouteCtx {
  /** Confine a user-supplied path. No-op when workspaceRoot is unset. */
  confine(userPath: unknown): string;
  /** Current workspace root (null => unconfined legacy mode). */
  workspaceRoot: string | null;
  /** Current conductor URL (null when unset). */
  getConductorUrl(): string | null;
  /** Update conductor URL (used by POST /config). */
  setConductorUrl(url: string | null): void;
}

import { resolve } from "path";
import { mkdirSync } from "fs";
import { confineToWorkspace, PathConfinementError } from "./confinement.js";
import { logDebug } from "../../core/observability/structured-log.js";

/**
 * Factory for the RouteCtx object shared with every route-family module.
 *
 * Resolves and (best-effort) creates the workspace root directory, builds the
 * `confine` closure, and wires the mutable conductorUrl accessors.
 */
export function createRouteCtx(opts: {
  workspaceRoot: string | null;
  getConductorUrl: () => string | null;
  setConductorUrl: (url: string | null) => void;
}): RouteCtx {
  // Workspace confinement root (P1-4). When set, every /file/* and /exec
  // request is restricted to paths under this directory. When unset,
  // arkd retains legacy unconfined behavior for local single-user mode.
  const workspaceRoot: string | null = opts.workspaceRoot ? resolve(opts.workspaceRoot) : null;
  if (workspaceRoot) {
    // Ensure the root exists so confined writes succeed out of the box.
    try {
      mkdirSync(workspaceRoot, { recursive: true });
    } catch {
      logDebug("compute", "best effort -- first real request will surface any permission error");
    }
  }

  /**
   * Enforce workspace confinement (no-op when workspaceRoot is null).
   * Returns the resolved absolute path, or throws PathConfinementError.
   */
  function confine(userPath: unknown): string {
    if (!workspaceRoot) {
      if (typeof userPath !== "string") {
        throw new PathConfinementError("path must be a string");
      }
      return userPath;
    }
    return confineToWorkspace(workspaceRoot, userPath);
  }

  return {
    confine,
    workspaceRoot,
    getConductorUrl: opts.getConductorUrl,
    setConductorUrl: opts.setConductorUrl,
  };
}

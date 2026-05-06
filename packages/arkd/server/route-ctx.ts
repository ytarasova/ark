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

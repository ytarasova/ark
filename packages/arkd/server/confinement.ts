/**
 * Workspace path confinement for /file/* and /exec.
 *
 * Server-only. Operates on real filesystem paths and returns the
 * resolved absolute path so callers can pass it straight to fs APIs.
 */

import { resolve, sep } from "path";

export class PathConfinementError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PathConfinementError";
  }
}

/**
 * Resolve a user-supplied path and verify it stays under `root`.
 *
 * `root` must be an absolute, canonical directory path. Throws when the
 * input tries to escape via `..`, absolute paths outside the root,
 * empty / non-string input, or NUL bytes.
 *
 * NOTE: this is a string-level guard. It does not `realpath` the target
 * (the file may not yet exist). Symlink traversal is mitigated at the
 * caller by refusing to write through links, but the primary defense
 * against malicious requests is that every absolute path NOT starting
 * with `root` is rejected outright.
 */
export function confineToWorkspace(root: string, userPath: unknown): string {
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw new PathConfinementError("path must be a non-empty string");
  }
  if (userPath.includes("\0")) {
    throw new PathConfinementError("path contains NUL byte");
  }
  const resolved = resolve(root, userPath);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new PathConfinementError(`path escapes workspace root: ${userPath}`);
  }
  return resolved;
}

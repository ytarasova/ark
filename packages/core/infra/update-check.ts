/**
 * Auto-update check -- looks for newer versions on GitHub.
 *
 * This is a best-effort background check. Errors (network, parse, disk)
 * are swallowed: a failed update check MUST NOT block the user from running
 * Ark. The caller treats `null` as "no update available / couldn't check".
 */

const REPO = process.env.ARK_GITHUB_REPO ?? "yana/ark";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";

interface UpdateState {
  lastCheck: string;
  latestVersion: string | null;
  currentVersion: string;
}

function statePath(arkDir: string): string {
  return join(arkDir, "update-check.json");
}

/** Get the current version from the root package.json. Walks up from __dirname
 * looking for a package.json whose "name" is "ark", so it works both when run
 * from source (bun) and from a compiled dist/ bundle. Falls back to 0.0.0 if
 * the file can't be located or parsed. */
export function getCurrentVersion(): string {
  try {
    let dir = __dirname;
    for (let i = 0; i < 10; i++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
        if (pkg.name === "ark") return pkg.version ?? "0.0.0";
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Check if an update is available. Returns the latest version or null. */
export async function checkForUpdate(arkDir?: string): Promise<string | null> {
  if (!arkDir) return null;
  try {
    const path = statePath(arkDir);
    const current = getCurrentVersion();

    if (existsSync(path)) {
      const state: UpdateState = JSON.parse(readFileSync(path, "utf-8"));
      const elapsed = Date.now() - new Date(state.lastCheck).getTime();
      if (elapsed < CHECK_INTERVAL_MS) {
        return state.latestVersion !== current ? state.latestVersion : null;
      }
    }

    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "User-Agent": "ark-update-check" },
    });

    if (!resp.ok) return null;
    const data = await resp.json() as { tag_name: string };
    const latest = data.tag_name?.replace(/^v/, "") ?? null;

    writeFileSync(path, JSON.stringify({
      lastCheck: new Date().toISOString(),
      latestVersion: latest,
      currentVersion: current,
    }));

    return latest && latest !== current ? latest : null;
  } catch {
    // Best-effort: any failure (offline, stale cache, disk full) means "don't show an update banner".
    return null;
  }
}

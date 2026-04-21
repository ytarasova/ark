/**
 * Auto-update check -- looks for newer versions on GitHub.
 *
 * This is a best-effort background check. Errors (network, parse, disk)
 * are swallowed: a failed update check MUST NOT block the user from running
 * Ark. The caller treats `null` as "no update available / couldn't check".
 *
 * LOCAL-ONLY. Called exclusively from the `ark` CLI binary's startup path
 * (`packages/cli/index.ts`) to render an "update available" banner to an
 * interactive user. It writes `{arkDir}/update-check.json` to throttle
 * subsequent checks. Neither the binary-update flow nor the cache file
 * makes sense on a hosted control plane where operators manage the image
 * lifecycle out of band. If a caller passes no `arkDir` the function
 * short-circuits to `null`, so any accidental wiring from shared handler
 * code simply no-ops rather than writing to a random disk location.
 */

const REPO = process.env.ARK_GITHUB_REPO ?? "yana/ark";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { VERSION } from "../version.js";

interface UpdateState {
  lastCheck: string;
  latestVersion: string | null;
  currentVersion: string;
}

function statePath(arkDir: string): string {
  return join(arkDir, "update-check.json");
}

/**
 * Get the current ark version. Baked into the binary at build time by
 * `scripts/inject-version.ts` (run before `bun build --compile`). The old
 * implementation read `package.json` via `__dirname` at runtime, which broke
 * in compiled binaries because (a) `__dirname` resolves into Bun's virtual
 * FS, and (b) `package.json` is not shipped in the release tarball.
 */
export function getCurrentVersion(): string {
  return VERSION;
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
    const data = (await resp.json()) as { tag_name: string };
    const latest = data.tag_name?.replace(/^v/, "") ?? null;

    writeFileSync(
      path,
      JSON.stringify({
        lastCheck: new Date().toISOString(),
        latestVersion: latest,
        currentVersion: current,
      }),
    );

    return latest && latest !== current ? latest : null;
  } catch {
    // Best-effort: any failure (offline, stale cache, disk full) means "don't show an update banner".
    return null;
  }
}

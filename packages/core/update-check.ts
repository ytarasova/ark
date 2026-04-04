/**
 * Auto-update check — looks for newer versions on GitHub.
 */

const REPO = process.env.ARK_GITHUB_REPO ?? "yana/ark";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { ARK_DIR } from "./store.js";

interface UpdateState {
  lastCheck: string;
  latestVersion: string | null;
  currentVersion: string;
}

function statePath(): string {
  return join(ARK_DIR(), "update-check.json");
}

/** Get the current version from package.json. */
export function getCurrentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Check if an update is available. Returns the latest version or null. */
export async function checkForUpdate(): Promise<string | null> {
  try {
    const path = statePath();
    const current = getCurrentVersion();

    // Rate limit checks
    if (existsSync(path)) {
      const state: UpdateState = JSON.parse(readFileSync(path, "utf-8"));
      const elapsed = Date.now() - new Date(state.lastCheck).getTime();
      if (elapsed < CHECK_INTERVAL_MS) {
        return state.latestVersion !== current ? state.latestVersion : null;
      }
    }

    // Check GitHub releases
    const resp = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "User-Agent": "ark-update-check" },
    });

    if (!resp.ok) return null;
    const data = await resp.json() as { tag_name: string };
    const latest = data.tag_name?.replace(/^v/, "") ?? null;

    // Save state
    writeFileSync(path, JSON.stringify({
      lastCheck: new Date().toISOString(),
      latestVersion: latest,
      currentVersion: current,
    }));

    return latest && latest !== current ? latest : null;
  } catch {
    return null;
  }
}

/**
 * Profile system -- isolated session namespaces.
 * Each profile gets its own set of sessions via group_name prefix.
 *
 * Persistence is local-only: profiles live in `<arkDir>/profiles.json`. In
 * hosted (control-plane) mode `setProfilesArkDir` is never called by the
 * conductor (`AppContext._initFilesystem` short-circuits in hosted mode), so
 * the module-level `_arkDir` stays null. The mutating CRUD functions throw a
 * clear error when called without an arkDir; `listProfiles` returns []. A
 * future migration can move profile storage to a tenant-scoped DB store; for
 * now any caller hitting these in hosted mode is a bug.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export interface Profile {
  name: string;
  description?: string;
  config?: Record<string, unknown>;
  createdAt: string;
}

let _arkDir: string | null = null;

/**
 * Set the ark directory for profile storage. Called during app boot.
 * Pass `null` to clear (used by tests that need to simulate "hosted mode
 * never bound an arkDir" between runs).
 */
export function setProfilesArkDir(arkDir: string | null): void {
  _arkDir = arkDir;
}

const HOSTED_UNAVAILABLE = "profiles unavailable in hosted mode (no per-process arkDir)";

function profilesPath(): string {
  if (!_arkDir) throw new Error("Profiles arkDir not set. Call setProfilesArkDir() first.");
  return join(_arkDir, "profiles.json");
}

function loadProfiles(): Profile[] {
  try {
    const path = profilesPath();
    if (!existsSync(path)) return [{ name: "default", createdAt: new Date().toISOString() }];
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [{ name: "default", createdAt: new Date().toISOString() }];
  }
}

function saveProfiles(profiles: Profile[]): void {
  writeFileSync(profilesPath(), JSON.stringify(profiles, null, 2));
}

let _activeProfile = process.env.ARK_PROFILE ?? "default";

export function getActiveProfile(): string {
  return _activeProfile;
}
export function setActiveProfile(name: string): void {
  _activeProfile = name;
}

export function listProfiles(): Profile[] {
  // Hosted mode never calls setProfilesArkDir; treat the missing arkDir as
  // "no profiles configured" rather than crashing the listing endpoint.
  if (!_arkDir) return [];
  return loadProfiles();
}

export function createProfile(name: string, description?: string): Profile {
  if (!_arkDir) throw new Error(HOSTED_UNAVAILABLE);
  const profiles = loadProfiles();
  if (profiles.find((p) => p.name === name)) {
    throw new Error(`Profile "${name}" already exists`);
  }
  const profile: Profile = { name, description, createdAt: new Date().toISOString() };
  profiles.push(profile);
  saveProfiles(profiles);
  return profile;
}

export function deleteProfile(name: string): boolean {
  if (!_arkDir) throw new Error(HOSTED_UNAVAILABLE);
  if (name === "default") throw new Error("Cannot delete the default profile");
  const profiles = loadProfiles();
  const idx = profiles.findIndex((p) => p.name === name);
  if (idx < 0) return false;
  profiles.splice(idx, 1);
  saveProfiles(profiles);
  return true;
}

/** Get the group prefix for the active profile. Default profile has no prefix. */
export function profileGroupPrefix(): string {
  if (_activeProfile === "default") return "";
  return `${_activeProfile}/`;
}

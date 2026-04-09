/**
 * Profile system — isolated session namespaces.
 * Each profile gets its own set of sessions via group_name prefix.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getApp } from "./app.js";

export interface Profile {
  name: string;
  description?: string;
  config?: Record<string, unknown>;
  createdAt: string;
}

function profilesPath(): string {
  return join(getApp().config.arkDir, "profiles.json");
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

export function getActiveProfile(): string { return _activeProfile; }
export function setActiveProfile(name: string): void { _activeProfile = name; }

export function listProfiles(): Profile[] { return loadProfiles(); }

export function createProfile(name: string, description?: string): Profile {
  const profiles = loadProfiles();
  if (profiles.find(p => p.name === name)) {
    throw new Error(`Profile "${name}" already exists`);
  }
  const profile: Profile = { name, description, createdAt: new Date().toISOString() };
  profiles.push(profile);
  saveProfiles(profiles);
  return profile;
}

export function deleteProfile(name: string): boolean {
  if (name === "default") throw new Error("Cannot delete the default profile");
  const profiles = loadProfiles();
  const idx = profiles.findIndex(p => p.name === name);
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

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const FILE = join(homedir(), ".ark", "recent-repos.json");

export function getRecentRepos(): string[] {
  try {
    return JSON.parse(readFileSync(FILE, "utf-8"));
  } catch {
    return [];
  }
}

export function addRecentRepo(repo: string): void {
  const recent = getRecentRepos().filter((r) => r !== repo);
  recent.unshift(repo);
  const trimmed = recent.slice(0, 20);
  try {
    mkdirSync(join(homedir(), ".ark"), { recursive: true });
    writeFileSync(FILE, JSON.stringify(trimmed, null, 2));
  } catch {
    // ignore write errors
  }
}

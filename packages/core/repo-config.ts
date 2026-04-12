import { existsSync, readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";

export interface RepoConfig {
  flow?: string;
  compute?: string;
  group?: string;
  agent?: string;
  env?: Record<string, string>;
  verify?: string[];  // Default verification scripts for all stages
  auto_pr?: boolean;  // Auto-create PR on agent completion (default: true for repos with remotes)
  auto_rebase?: boolean;  // Auto-rebase onto base branch before PR creation (default: true)
}

export function loadRepoConfig(dir: string): RepoConfig {
  for (const name of [".ark.yaml", ".ark.yml", "ark.yaml"]) {
    const path = join(dir, name);
    if (existsSync(path)) {
      try {
        return (YAML.parse(readFileSync(path, "utf-8")) ?? {}) as RepoConfig;
      } catch { return {}; }
    }
  }
  return {};
}

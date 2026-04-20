/**
 * Trigger store -- loads `triggers/*.yaml` from the shipped repo/tarball and
 * `<arkDir>/triggers/` for user-scoped configs.
 *
 * Multi-tenant mode (control-plane profile): each tenant has its own
 * subdirectory `<arkDir>/triggers/<tenantId>/*.yaml` in addition to the
 * shared builtin + global directories. Callers pass `tenant` to `list/get`
 * to scope lookups. Tenant-level configs override global, which override
 * builtin (by config name).
 *
 * DB-backed storage is a future extension -- this phase reads filesystem
 * only. `reload()` re-reads on demand for the CLI `ark trigger reload` flow.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import type { TriggerConfig, TriggerStore } from "./types.js";
import { logDebug } from "../observability/structured-log.js";

export interface FileTriggerStoreOpts {
  /** Builtin dir (usually `<repoRoot>/triggers` or `<prefix>/triggers`). */
  builtinDir?: string;
  /** User-scoped dir (`<arkDir>/triggers`). Per-tenant subdirs below this. */
  userDir?: string;
}

function loadDir(dir: string, defaultTenant: string): TriggerConfig[] {
  if (!existsSync(dir)) return [];
  const out: TriggerConfig[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
    // Skip `*.yaml.example` scaffolds -- those are documentation, not live configs.
    if (file.endsWith(".example")) continue;
    const path = join(dir, file);
    try {
      if (!statSync(path).isFile()) continue;
      const raw = readFileSync(path, "utf-8");
      const parsed = parseYaml(raw) as Partial<TriggerConfig> | null;
      if (!parsed) continue;
      if (!parsed.name) parsed.name = file.replace(/\.ya?ml$/, "");
      if (!parsed.source) {
        logDebug("triggers", `skip ${file}: missing 'source' field`);
        continue;
      }
      if (!parsed.flow) {
        logDebug("triggers", `skip ${file}: missing 'flow' field`);
        continue;
      }
      if (parsed.enabled === undefined) parsed.enabled = true;
      if (!parsed.kind) parsed.kind = "webhook";
      if (!parsed.tenant) parsed.tenant = defaultTenant;
      out.push(parsed as TriggerConfig);
    } catch (e: any) {
      logDebug("triggers", `failed to load ${path}: ${e?.message ?? e}`);
    }
  }
  return out;
}

export class FileTriggerStore implements TriggerStore {
  private readonly builtinDir?: string;
  private readonly userDir?: string;
  private readonly cache = new Map<string, TriggerConfig[]>();

  constructor(opts: FileTriggerStoreOpts) {
    this.builtinDir = opts.builtinDir;
    this.userDir = opts.userDir;
  }

  list(tenant = "default"): TriggerConfig[] {
    const cached = this.cache.get(tenant);
    if (cached) return cached;
    const builtin = this.builtinDir ? loadDir(this.builtinDir, tenant) : [];
    const global = this.userDir ? loadDir(this.userDir, tenant) : [];
    const tenantDir = this.userDir ? join(this.userDir, tenant) : undefined;
    const tenantConfigs = tenantDir ? loadDir(tenantDir, tenant) : [];
    // Precedence: tenant > global > builtin (by name).
    const merged = new Map<string, TriggerConfig>();
    for (const c of builtin) merged.set(c.name, c);
    for (const c of global) merged.set(c.name, c);
    for (const c of tenantConfigs) merged.set(c.name, c);
    const arr = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.cache.set(tenant, arr);
    return arr;
  }

  get(name: string, tenant = "default"): TriggerConfig | null {
    return this.list(tenant).find((c) => c.name === name) ?? null;
  }

  reload(): void {
    this.cache.clear();
  }

  /**
   * In-memory enable/disable. Persistence to disk is a future extension.
   * The CLI flow prints a hint clarifying the change does not survive restart.
   */
  enable(name: string, enabled: boolean, tenant = "default"): boolean {
    const list = this.list(tenant);
    const cfg = list.find((c) => c.name === name);
    if (!cfg) return false;
    cfg.enabled = enabled;
    return true;
  }
}

/** Convenience factory: build a FileTriggerStore from arkDir + optional builtin base. */
export function createFileTriggerStore(opts: { arkDir: string; builtinBaseDir?: string }): FileTriggerStore {
  return new FileTriggerStore({
    builtinDir: opts.builtinBaseDir ? join(opts.builtinBaseDir, "triggers") : undefined,
    userDir: join(opts.arkDir, "triggers"),
  });
}

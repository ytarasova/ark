/**
 * PluginRegistry -- typed collection-of-things-by-kind.
 *
 * Awilix owns singleton services (db, repos, stores). PluginRegistry owns
 * the extensible collections: executors, compute providers, transcript
 * parsers, runtimes, and anything else where "there are N of these and
 * users can add more."
 *
 * Why a separate registry instead of raw Awilix keys like `executor:goose`?
 *
 *   1. Typed: `registry.get("executor", "goose")` returns `Executor | undefined`,
 *      not `unknown`. The kind and name are both compile-time checked.
 *   2. Listable: `registry.listByKind("executor")` returns every executor
 *      without walking Awilix keys by string pattern.
 *   3. Source-tracked: every entry carries provenance (builtin | user | project
 *      | tenant), so future policy gates ("tenants can't use project-level
 *      plugins") have somewhere to attach.
 *   4. Lifecycle-friendly: hot-reload needs `unregister(kind, name)` and an
 *      `onUnload` hook per entry, which Awilix doesn't cleanly model.
 *
 * The registry itself is registered into Awilix as `pluginRegistry`, so any
 * service that depends on plugins resolves it via DI like any other service.
 */

import type { Executor } from "../executor.js";

/**
 * Backward-compat aliases for the May 2026 runtime rename. Mirrors the map in
 * `executor.ts` -- both lookups (plugin registry first, global registry second)
 * normalise the same legacy names so persisted `launch_executor` values keep
 * resolving across the cutover.
 */
const EXECUTOR_NAME_ALIASES: Record<string, string> = {
  "agent-sdk": "claude-agent",
};

// ── Plugin kinds ────────────────────────────────────────────────────────────
//
// Today only executors are registered. Future extensions: compute-provider,
// runtime, transcript-parser, flow, skill, recipe, agent. The map below
// defines the type for each kind; adding a new kind means adding one line here.

export interface PluginKindMap {
  executor: Executor;
  // Future extensions land as new entries in this interface, e.g.:
  // "compute": Compute;
  // "transcript-parser": TranscriptParser;
  // "runtime": RuntimeDefinition;
}

export type PluginKind = keyof PluginKindMap;

// ── Entry metadata ─────────────────────────────────────────────────────────

export type PluginSource = "builtin" | "user" | "project" | "tenant";

export interface PluginEntry<K extends PluginKind = PluginKind> {
  kind: K;
  name: string;
  impl: PluginKindMap[K];
  source: PluginSource;
  /** Optional free-text version. A future revision may promote this to a structured manifest. */
  version?: string;
  /** Where this plugin was loaded from, if known. Useful for error messages. */
  path?: string;
}

// ── Registry ────────────────────────────────────────────────────────────────

export interface PluginRegistry {
  register<K extends PluginKind>(entry: PluginEntry<K>): void;
  unregister(kind: PluginKind, name: string): boolean;
  get<K extends PluginKind>(kind: K, name: string): PluginKindMap[K] | undefined;
  getEntry<K extends PluginKind>(kind: K, name: string): PluginEntry<K> | undefined;
  listByKind<K extends PluginKind>(kind: K): PluginEntry<K>[];
  clear(kind?: PluginKind): void;
  /** Typed shortcut: pluginRegistry.executor("goose") === pluginRegistry.get("executor", "goose"). */
  executor(name: string): Executor | undefined;
}

/**
 * Create a fresh PluginRegistry. Called from app boot -- not a module-level
 * singleton because tests need isolated instances per AppContext.
 */
export function createPluginRegistry(): PluginRegistry {
  // Kind → name → entry
  const entries = new Map<PluginKind, Map<string, PluginEntry>>();

  function bucket(kind: PluginKind): Map<string, PluginEntry> {
    let b = entries.get(kind);
    if (!b) {
      b = new Map();
      entries.set(kind, b);
    }
    return b;
  }

  return {
    register(entry) {
      bucket(entry.kind).set(entry.name, entry as PluginEntry);
    },

    unregister(kind, name) {
      const b = entries.get(kind);
      if (!b) return false;
      return b.delete(name);
    },

    get(kind, name) {
      const entry = entries.get(kind)?.get(name);
      return entry?.impl as PluginKindMap[typeof kind] | undefined;
    },

    getEntry(kind, name) {
      return entries.get(kind)?.get(name) as PluginEntry<typeof kind> | undefined;
    },

    listByKind(kind) {
      const b = entries.get(kind);
      if (!b) return [];
      return Array.from(b.values()) as PluginEntry<typeof kind>[];
    },

    clear(kind) {
      if (kind) {
        entries.delete(kind);
      } else {
        entries.clear();
      }
    },

    executor(name) {
      const resolved = EXECUTOR_NAME_ALIASES[name] ?? name;
      return this.get("executor", resolved);
    },
  };
}

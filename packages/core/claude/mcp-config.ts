/**
 * Channel / MCP config writing for the Claude worktree.
 *
 * Responsible for assembling `.mcp.json` in the worktree so Claude Code
 * finds the ark-channel server plus any runtime / repo-declared MCP
 * servers at startup. Also handles cleanup on session stop.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join, resolve } from "path";

import { DEFAULT_CONDUCTOR_URL } from "../constants.js";
import { channelLaunchSpec } from "../install-paths.js";
import { findCodebaseMemoryBinary } from "../knowledge/codebase-memory-finder.js";
import { logDebug } from "../observability/structured-log.js";

// ── Channel MCP config ──────────────────────────────────────────────────────

export function channelMcpConfig(
  sessionId: string,
  stage: string,
  channelPort: number,
  opts?: { conductorUrl?: string; tenantId?: string },
): Record<string, unknown> {
  const env: Record<string, string> = {
    ARK_SESSION_ID: sessionId,
    ARK_STAGE: stage,
    ARK_CHANNEL_PORT: String(channelPort),
    ARK_CONDUCTOR_URL: opts?.conductorUrl ?? DEFAULT_CONDUCTOR_URL,
  };
  if (opts?.tenantId) env.ARK_TENANT_ID = opts.tenantId;
  // channelLaunchSpec() returns:
  //   compiled mode: { command: process.execPath, args: ["channel"] }
  //   dev mode:      { command: bun, args: [<repo>/packages/cli/index.ts, "channel"] }
  // This replaces the old `bun + CHANNEL_SCRIPT_PATH` approach which broke in
  // compiled binaries because channel.ts lived in Bun's virtual FS, not on disk.
  const spec = channelLaunchSpec();
  return {
    command: spec.command,
    args: spec.args,
    env,
  };
}

/**
 * Expand `${ENV_NAME}` and `${ENV_NAME:-default}` placeholders inside an
 * MCP server config against `process.env`. Used by runtime-level MCP
 * entries so a single YAML / JSON stub can be parameterised per
 * deployment (e.g. URLs, API tokens, sockets) with a shipped default.
 *
 * Walks objects/arrays recursively. Non-string leaves are left untouched.
 * Missing env vars without a default are left as the literal `${VAR}` so
 * the underlying MCP server can decide whether to error -- we don't want
 * to swallow misconfig silently here.
 */
export function expandEnvPlaceholders<T>(value: T, env: Record<string, string | undefined> = process.env): T {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (full, name, fallback) => {
      const resolved = env[name];
      if (resolved !== undefined && resolved !== "") return resolved;
      if (fallback !== undefined) return fallback;
      return full;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnvPlaceholders(v, env)) as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvPlaceholders(v, env);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Resolve an MCP server entry into a `{ name, config }` pair suitable for
 * writing into `.mcp.json["mcpServers"]`. Supports the same input shapes
 * as `RuntimeDefinition.mcp_servers` and `AgentDefinition.mcp_servers`:
 *   - string path to `<somewhere>/<name>.json` (loaded from disk; the file
 *     must contain `{"mcpServers": { "<name>": { ... } }}`)
 *   - bare server name like `"pi-sage"` -- looked up in `mcpConfigsDir` if
 *     supplied, otherwise treated as just a name with no config to add
 *   - inline object `{ "<name>": { command, args, env } | { type, url } }`
 * Returns `null` when the entry can't be resolved (file missing, etc.).
 */
function resolveMcpServerEntry(
  entry: string | Record<string, unknown>,
  opts?: { mcpConfigsDir?: string },
): { name: string; config: Record<string, unknown> } | null {
  if (typeof entry === "object" && entry !== null) {
    const keys = Object.keys(entry);
    if (keys.length !== 1) return null;
    const name = keys[0];
    const raw = entry[name];
    if (typeof raw !== "object" || raw === null) return null;
    return { name, config: expandEnvPlaceholders(raw as Record<string, unknown>) };
  }

  if (typeof entry !== "string") return null;

  // Determine candidate file path -- either explicit, or look up in mcpConfigsDir
  let filePath: string | null = null;
  let derivedName: string;
  if (entry.endsWith(".json") || entry.includes("/")) {
    filePath = resolve(entry);
    derivedName = (entry.split("/").pop() ?? entry).replace(/\.json$/, "");
  } else {
    derivedName = entry;
    if (opts?.mcpConfigsDir) {
      filePath = join(opts.mcpConfigsDir, `${entry}.json`);
    }
  }

  if (!filePath || !existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    const servers = parsed.mcpServers as Record<string, Record<string, unknown>> | undefined;
    if (!servers) return null;
    // Prefer the entry whose key matches `derivedName`; fall back to the only entry.
    const match = servers[derivedName] ?? (Object.keys(servers).length === 1 ? servers[Object.keys(servers)[0]] : null);
    if (!match) return null;
    return { name: derivedName, config: expandEnvPlaceholders(match) };
  } catch (e: any) {
    console.error(`resolveMcpServerEntry: failed to load ${filePath}:`, e?.message ?? e);
    return null;
  }
}

/**
 * Write channel MCP config to the worktree's .mcp.json.
 * Claude Code reads .mcp.json from the project directory at startup.
 * --dangerously-load-development-channels server:NAME looks up NAME
 * in the loaded MCP config, so the server must be in .mcp.json.
 *
 * Merge order (later wins for the same name only via opt-in entries; the
 * channel + codebase-memory are always written last so they cannot be
 * shadowed by repo / runtime config):
 *   1. existing `.mcp.json` in the worktree
 *   2. servers copied from `originalRepoDir/.mcp.json` (skips `ark-channel`,
 *      never overwrites existing names)
 *   3. servers declared in the runtime YAML (`runtimeMcpServers`)
 *   4. `ark-channel` (always overwritten)
 *   5. `codebase-memory` (only if the binary is on disk and not already set)
 */
export function writeChannelConfig(
  sessionId: string,
  stage: string,
  channelPort: number,
  workdir: string,
  opts?: {
    conductorUrl?: string;
    channelConfig?: Record<string, unknown>;
    tracksDir?: string;
    originalRepoDir?: string;
    /** MCP servers declared on the active runtime YAML. */
    runtimeMcpServers?: (string | Record<string, unknown>)[];
    /** Directory holding `<name>.json` files referenced by string entries. */
    mcpConfigsDir?: string;
    /**
     * When true, additionally inject the unified `ark-code-intel` MCP server
     * alongside the legacy `codebase-memory` entry. Gated by
     * `config.features.codeIntelV2`. Wave 1 default: false.
     */
    enableCodeIntelV2?: boolean;
  },
): string {
  const config =
    opts?.channelConfig ?? channelMcpConfig(sessionId, stage, channelPort, { conductorUrl: opts?.conductorUrl });

  // Write to worktree .mcp.json so Claude finds it
  const mcpConfigPath = join(workdir, ".mcp.json");
  let existing: Record<string, any> = {};
  if (existsSync(mcpConfigPath)) {
    try {
      existing = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
    } catch (e: any) {
      console.error(`writeChannelConfig: failed to parse ${mcpConfigPath}:`, e?.message ?? e);
    }
  }

  // Merge MCP servers from the original repo's .mcp.json into the worktree.
  // Git worktrees don't include untracked files like .mcp.json, so agents in
  // worktrees would lose access to MCP servers configured in the original repo.
  if (opts?.originalRepoDir && resolve(opts.originalRepoDir) !== resolve(workdir)) {
    const origMcpPath = join(opts.originalRepoDir, ".mcp.json");
    if (existsSync(origMcpPath)) {
      try {
        const origConfig = JSON.parse(readFileSync(origMcpPath, "utf-8"));
        if (origConfig.mcpServers && typeof origConfig.mcpServers === "object") {
          if (!existing.mcpServers) existing.mcpServers = {};
          for (const [name, serverConfig] of Object.entries(origConfig.mcpServers)) {
            // Skip ark-channel (we write our own) and don't override existing entries
            if (name !== "ark-channel" && !existing.mcpServers[name]) {
              existing.mcpServers[name] = serverConfig;
            }
          }
        }
      } catch (e: any) {
        console.error(
          `writeChannelConfig: failed to merge original repo MCP config from ${origMcpPath}:`,
          e?.message ?? e,
        );
      }
    }
  }

  // Merge runtime-declared MCP servers (e.g. from runtimes/claude.yaml). Same
  // precedence as the original-repo merge: do not override entries already
  // present in the worktree's .mcp.json or in the source repo's .mcp.json.
  if (opts?.runtimeMcpServers?.length) {
    if (!existing.mcpServers) existing.mcpServers = {};
    for (const entry of opts.runtimeMcpServers) {
      const resolved = resolveMcpServerEntry(entry, { mcpConfigsDir: opts.mcpConfigsDir });
      if (!resolved) continue;
      if (resolved.name === "ark-channel") continue;
      if (existing.mcpServers[resolved.name]) continue;
      existing.mcpServers[resolved.name] = resolved.config;
    }
  }

  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers["ark-channel"] = config;

  // Inject codebase-memory-mcp if the vendored binary is available.
  // It speaks MCP over stdio with no args -- invoking the binary directly
  // gives the agent its 14 code-intelligence tools (search_graph, trace_path,
  // get_architecture, search_code, manage_adr, etc.).
  // See docs/2026-04-18-CODE_INTELLIGENCE_DESIGN.md.
  const cbmBin = findCodebaseMemoryBinary();
  const cbmAvailable = cbmBin !== "codebase-memory-mcp" && existsSync(cbmBin);
  if (cbmAvailable && !existing.mcpServers["codebase-memory"]) {
    existing.mcpServers["codebase-memory"] = {
      command: cbmBin,
      args: [],
      env: {
        // Keep the HTTP graph UI disabled by default; arkd pool may override.
        CBM_UI_ENABLED: "false",
      },
    };
  }

  // Wave 1: gate the unified code-intel MCP behind the codeIntelV2 flag.
  // The MCP server itself ships in Wave 2; for now we leave the entry name
  // as the stable contract and skip injection until both the flag and the
  // server binary are present.
  if (opts?.enableCodeIntelV2 && !existing.mcpServers["ark-code-intel"]) {
    // The MCP server binary lands in Wave 2. Until then, the flag has no
    // observable effect at write-time -- intentional: we don't want to
    // inject a broken MCP entry, but we do want the gate to be wired so
    // downstream wiring lights up the moment the server ships.
    void existing;
  }

  writeFileSync(mcpConfigPath, JSON.stringify(existing, null, 2));

  // Also write a copy to tracks dir for reference
  if (opts?.tracksDir) {
    const sessionDir = join(opts.tracksDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "mcp.json"), JSON.stringify({ mcpServers: { "ark-channel": config } }, null, 2));
  }

  return mcpConfigPath;
}

/**
 * Remove the ark-channel entry from the worktree's .mcp.json.
 * Mirrors removeSettings -- called on session stop/delete to avoid
 * stale MCP config pointing at a dead channel port.
 */
export function removeChannelConfig(workdir: string): void {
  const mcpConfigPath = join(workdir, ".mcp.json");
  if (!existsSync(mcpConfigPath)) return;

  let config: Record<string, any>;
  try {
    config = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
  } catch (e: any) {
    console.error(`removeChannelConfig: failed to parse ${mcpConfigPath}:`, e?.message ?? e);
    return;
  }

  if (config.mcpServers && typeof config.mcpServers === "object") {
    // Remove every entry ark auto-injected via writeChannelConfig so the
    // .mcp.json ends up in the same state it was in before dispatch. If we
    // only scrub `ark-channel`, a laptop with `codebase-memory-mcp` installed
    // leaves a `codebase-memory` entry behind and the file never gets
    // cleaned up.
    for (const name of ["ark-channel", "codebase-memory", "ark-code-intel"]) {
      delete config.mcpServers[name];
    }
    if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
  }

  // If only empty object remains, remove the file entirely
  if (Object.keys(config).length === 0) {
    try {
      unlinkSync(mcpConfigPath);
    } catch {
      logDebug("session", "already gone");
    }
  } else {
    writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
  }
}

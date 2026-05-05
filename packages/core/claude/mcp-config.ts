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
import { logDebug } from "../observability/structured-log.js";

// ── Channel MCP config ──────────────────────────────────────────────────────

/**
 * Local-mode channel MCP config -- spec.command resolves against the
 * CONDUCTOR's filesystem (process.execPath in compiled mode, bun + the
 * conductor's repo in dev mode). Only correct when the agent runs on the
 * conductor's host.
 *
 * REMOTE DISPATCH MUST NOT use this. For remote dispatch the channel MCP
 * config has to come from `provider.buildChannelConfig` (e.g.
 * `RemoteWorktreeProvider.buildChannelConfig` -- returns
 * `${REMOTE_HOME}/.ark/bin/ark channel`, the binary path that exists on
 * the agent's host). `claude-code.ts:executor.launch` enforces this with
 * an explicit assertion (audit finding F6); without that guard, a falsy
 * `channelConfig` would silently fall back here and embed the conductor's
 * binary path in the agent's `.mcp.json`.
 */
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

/** Inputs shared by the pure channel-config builder + the on-disk writer. */
export interface BuildChannelConfigOpts {
  conductorUrl?: string;
  channelConfig?: Record<string, unknown>;
  originalRepoDir?: string;
  /** MCP servers declared on the active runtime YAML. */
  runtimeMcpServers?: (string | Record<string, unknown>)[];
  /** Directory holding `<name>.json` files referenced by string entries. */
  mcpConfigsDir?: string;
  /** Pre-parsed existing `.mcp.json` to merge with (writeChannelConfig fills this). */
  existing?: Record<string, any>;
}

/**
 * Pure builder: produces the merged `.mcp.json` JSON given the inputs above.
 * No filesystem writes. Used by `writeChannelConfig` (which adds I/O + reads
 * the existing file) and by the remote launcher path (which embeds the JSON
 * as a heredoc that runs on the remote host).
 *
 * Merge order, later wins only via opt-in entries:
 *   1. `opts.existing` (whatever was already in `.mcp.json`)
 *   2. `originalRepoDir/.mcp.json` (skip `ark-channel`, don't overwrite)
 *   3. runtime-declared MCP servers (skip `ark-channel`, don't overwrite)
 *   4. `ark-channel` (always overwritten)
 */
export function buildChannelConfig(
  sessionId: string,
  stage: string,
  channelPort: number,
  opts?: BuildChannelConfigOpts,
): { object: Record<string, any>; content: string } {
  const config =
    opts?.channelConfig ?? channelMcpConfig(sessionId, stage, channelPort, { conductorUrl: opts?.conductorUrl });

  const existing: Record<string, any> = opts?.existing ? { ...opts.existing } : {};

  // 2. originalRepoDir merge -- only meaningful on the local conductor where
  //    the repo dir is on disk.
  if (opts?.originalRepoDir) {
    const origMcpPath = join(opts.originalRepoDir, ".mcp.json");
    if (existsSync(origMcpPath)) {
      try {
        const origConfig = JSON.parse(readFileSync(origMcpPath, "utf-8"));
        if (origConfig.mcpServers && typeof origConfig.mcpServers === "object") {
          if (!existing.mcpServers) existing.mcpServers = {};
          for (const [name, serverConfig] of Object.entries(origConfig.mcpServers)) {
            if (name !== "ark-channel" && !existing.mcpServers[name]) {
              existing.mcpServers[name] = serverConfig;
            }
          }
        }
      } catch (e: any) {
        console.error(
          `buildChannelConfig: failed to merge original repo MCP config from ${origMcpPath}:`,
          e?.message ?? e,
        );
      }
    }
  }

  // 3. runtime-declared MCP servers
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

  // 4. ark-channel always wins
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers["ark-channel"] = config;

  return { object: existing, content: JSON.stringify(existing, null, 2) };
}

/**
 * Write channel MCP config to the worktree's .mcp.json.
 * Claude Code reads .mcp.json from the project directory at startup.
 * --dangerously-load-development-channels server:NAME looks up NAME
 * in the loaded MCP config, so the server must be in .mcp.json.
 *
 * Wraps `buildChannelConfig` with: read the existing local file, hand it to
 * the builder, atomically write the result, optionally also drop a sidecar
 * copy under `tracksDir/<sessionId>/mcp.json` for offline inspection.
 */
export function writeChannelConfig(
  sessionId: string,
  stage: string,
  channelPort: number,
  workdir: string,
  opts?: BuildChannelConfigOpts & { tracksDir?: string },
): string {
  const mcpConfigPath = join(workdir, ".mcp.json");
  let existing: Record<string, any> = {};
  if (existsSync(mcpConfigPath)) {
    try {
      existing = JSON.parse(readFileSync(mcpConfigPath, "utf-8"));
    } catch (e: any) {
      console.error(`writeChannelConfig: failed to parse ${mcpConfigPath}:`, e?.message ?? e);
    }
  }

  const { object, content } = buildChannelConfig(sessionId, stage, channelPort, { ...opts, existing });
  writeFileSync(mcpConfigPath, content);

  if (opts?.tracksDir) {
    const sessionDir = join(opts.tracksDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const channelOnly = JSON.stringify({ mcpServers: { "ark-channel": object.mcpServers["ark-channel"] } }, null, 2);
    writeFileSync(join(sessionDir, "mcp.json"), channelOnly);
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
    // Remove ark-injected entries so .mcp.json returns to its pre-dispatch state.
    delete config.mcpServers["ark-channel"];
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

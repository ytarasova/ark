/**
 * install-paths -- one place to resolve filesystem paths for shipped resources.
 *
 * Why this module exists
 * ======================
 *
 * Ark ships as a single Bun-compiled binary plus a set of sibling resource
 * directories (flows, skills, agents, recipes, runtimes, web). When code
 * inside `packages/core/` needs to find those siblings at runtime, it has to
 * answer a deceptively hard question: "where am I installed?"
 *
 * The naive answer -- compute the path from `import.meta.url` at module load
 * time -- is correct in dev mode (`bun run`) but silently wrong in compiled
 * mode (`bun build --compile`). In compiled mode, Bun loads bundled modules
 * from a virtual filesystem rooted at `/$bunfs/root/`, so `import.meta.url`
 * points into that virtual FS, NOT to the on-disk location of the binary.
 * Path arithmetic from `import.meta.url` ends up pointing at paths that don't
 * exist on the host.
 *
 * This bug has historically shown up as several independent-looking issues:
 *
 *   - `ark web` returns 404 for every route (web.ts:WEB_DIST)
 *   - Web proxy mode returns 404 (web-proxy.ts:WEB_DIST)
 *   - All 5 builtin resource stores are empty (app.ts:storeBaseDir)
 *   - MCP channel subprocess fails to launch (constants.ts:CHANNEL_SCRIPT_PATH)
 *
 * All four are the same root cause in different files. This module centralises
 * the resolution logic so there is ONE place to fix path bugs, and so new code
 * that needs to locate a shipped resource has an obvious function to call.
 *
 * Every resolver exposes TWO variants:
 *
 *   `resolveFooWith({ execPath, sourceUrl, existsCheck })` -- a pure function
 *   that takes its environment as arguments. This is what unit tests drive.
 *
 *   `resolveFoo()` -- the convenience wrapper that calls the pure variant
 *   with `process.execPath`, `import.meta.url`, and `fs.existsSync`. This is
 *   what production code calls.
 *
 * `process.execPath` is well-defined in Bun-compiled binaries -- it returns
 * the actual on-disk path of the binary, NOT the virtual FS path. This is
 * the critical asymmetry with `import.meta.url`, which returns the virtual
 * path. The resolvers use execPath to find installed-tarball layouts and
 * fall back to `import.meta.url` for dev-mode source-tree layouts.
 */

import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { logDebug } from "./observability/structured-log.js";

export interface ResolveEnv {
  /** Path to the currently-executing binary (typically `process.execPath`). */
  execPath: string;
  /** URL of the calling module (typically `import.meta.url`). */
  sourceUrl: string;
  /** Filesystem existence check (typically `fs.existsSync`). */
  existsCheck: (path: string) => boolean;
}

/** Production defaults used by the convenience wrappers. */
function defaultEnv(): ResolveEnv {
  return {
    execPath: process.execPath,
    sourceUrl: import.meta.url,
    existsCheck: existsSync,
  };
}

/**
 * Walk back from the install-paths module location to the repo root.
 * `sourceUrl` is expected to be `install-paths.ts`'s own URL, which lives at
 * `<repo>/packages/core/install-paths.ts`. Walking `..`/`..`/`..` gives the
 * repo root in dev mode. In compiled mode this lands inside the virtual FS
 * and should not be used for filesystem access.
 */
function sourceRepoRootFrom(sourceUrl: string): string {
  return join(fileURLToPath(sourceUrl), "..", "..", "..");
}

/**
 * Return the install prefix (the directory containing `bin/`, `flows/`,
 * `web/`, etc) if we can find one on disk, or null if we can't.
 *
 * Detects the installed layout by checking for `flows/definitions/` next
 * to the executable -- that is the distinctive marker of the release
 * tarball shape.
 */
export function resolveInstallPrefixWith(env: ResolveEnv): string | null {
  try {
    const prefix = join(dirname(env.execPath), "..");
    if (env.existsCheck(join(prefix, "flows", "definitions"))) {
      return prefix;
    }
  } catch {
    logDebug("session", "fall through");
  }
  return null;
}

export function resolveInstallPrefix(): string | null {
  return resolveInstallPrefixWith(defaultEnv());
}

/**
 * Detect whether we are running inside a Bun-compiled binary.
 *
 * Heuristic: the install-prefix marker (`<execPath>/../flows/definitions`)
 * exists. That marker is present in the release tarball layout but NOT in
 * dev mode (where `process.execPath` is the bun runtime binary).
 *
 * Used by `channelLaunchSpec` to decide whether to spawn the binary itself
 * with a subcommand or to spawn bun with a script path.
 */
export function isCompiledBinaryWith(env: ResolveEnv): boolean {
  return resolveInstallPrefixWith(env) !== null;
}

export function isCompiledBinary(): boolean {
  return isCompiledBinaryWith(defaultEnv());
}

/**
 * Resolve the base directory that contains builtin resource definitions
 * (flows, skills, agents, recipes, runtimes). Consumed by AppContext when
 * constructing the file-backed resource stores.
 *
 * Installed tarball layout:
 *   <prefix>/bin/ark                  <-- execPath
 *   <prefix>/flows/definitions/*.yaml <-- returned here joined with "flows/definitions"
 *   <prefix>/skills/*.md
 *   <prefix>/agents/*.yaml
 *
 * Source-tree layout:
 *   <repo>/packages/core/install-paths.ts
 *   <repo>/flows/definitions/*.yaml   <-- returned here
 *   <repo>/skills/*.md
 */
export function resolveStoreBaseDirWith(env: ResolveEnv): string {
  const installed = resolveInstallPrefixWith(env);
  if (installed) return installed;
  return sourceRepoRootFrom(env.sourceUrl);
}

export function resolveStoreBaseDir(): string {
  return resolveStoreBaseDirWith(defaultEnv());
}

/**
 * Resolve the directory containing the built web dashboard assets (index.html
 * and the assets/ subdir). Consumed by both `hosted/web.ts` (local server)
 * and `hosted/web-proxy.ts` (proxy to remote control plane).
 *
 * Installed tarball layout:
 *   <prefix>/bin/ark            <-- execPath
 *   <prefix>/web/index.html     <-- returned here
 *   <prefix>/web/assets/...
 *
 * Source-tree layout:
 *   <repo>/packages/core/install-paths.ts
 *   <repo>/packages/web/dist/index.html   <-- returned here
 */
export function resolveWebDistWith(env: ResolveEnv): string {
  const installed = resolveInstallPrefixWith(env);
  if (installed) {
    const installedWeb = join(installed, "web");
    if (env.existsCheck(join(installedWeb, "index.html"))) {
      return installedWeb;
    }
  }
  // Source-tree fallback
  const sourceDist = join(sourceRepoRootFrom(env.sourceUrl), "packages", "web", "dist");
  if (env.existsCheck(sourceDist)) return sourceDist;
  // Neither exists. Prefer the installed-layout path so error messages point
  // somewhere meaningful to a user.
  if (installed) return join(installed, "web");
  return sourceDist;
}

export function resolveWebDist(): string {
  return resolveWebDistWith(defaultEnv());
}

/**
 * Return the command + args to spawn when launching the channel MCP server
 * as a subprocess. The channel is used by the claude executor and local
 * compute providers to wire agent-to-conductor messaging.
 *
 * Compiled binary:
 *   command = execPath            (the ark binary itself)
 *   args    = ["channel"]         (the `ark channel` subcommand)
 *
 * Dev mode:
 *   command = execPath            (the bun runtime)
 *   args    = [<repo>/packages/cli/index.ts, "channel"]
 *
 * Why not keep using a filesystem path to channel.ts: in compiled binaries,
 * `channel.ts` doesn't exist on disk -- it's bundled into the ark binary.
 * Spawning `bun /$bunfs/root/.../channel.ts` fails because the host kernel
 * can't see that path. The fix is to have the compiled binary spawn itself
 * with the `channel` subcommand, which is already wired up in
 * `packages/cli/commands/misc.ts`.
 */
export function channelLaunchSpecWith(env: ResolveEnv): { command: string; args: string[] } {
  if (isCompiledBinaryWith(env)) {
    return { command: env.execPath, args: ["channel"] };
  }
  // Dev mode: bun <repo>/packages/cli/index.ts channel
  const cliEntry = join(sourceRepoRootFrom(env.sourceUrl), "packages", "cli", "index.ts");
  return { command: env.execPath, args: [cliEntry, "channel"] };
}

export function channelLaunchSpec(): { command: string; args: string[] } {
  return channelLaunchSpecWith(defaultEnv());
}

/**
 * Return the command + args to spawn when launching the agent-sdk runtime
 * as a child process. Mirrors the channelLaunchSpec pattern.
 *
 * Compiled binary:
 *   command = execPath              (the ark binary itself)
 *   args    = ["run-agent-sdk"]     (the `ark run-agent-sdk` subcommand)
 *
 * Dev mode:
 *   command = execPath              (the bun runtime)
 *   args    = [<repo>/packages/core/runtimes/agent-sdk/launch.ts]
 *
 * The launch script reads all context from ARK_* env vars -- callers do not
 * need to pass additional positional arguments.
 */
export function agentSdkLaunchSpecWith(env: ResolveEnv): { command: string; args: string[] } {
  if (isCompiledBinaryWith(env)) {
    return { command: env.execPath, args: ["run-agent-sdk"] };
  }
  // Dev mode: bun <repo>/packages/core/runtimes/agent-sdk/launch.ts
  const launchScript = join(
    sourceRepoRootFrom(env.sourceUrl),
    "packages",
    "core",
    "runtimes",
    "agent-sdk",
    "launch.ts",
  );
  return { command: env.execPath, args: [launchScript] };
}

export function agentSdkLaunchSpec(): { command: string; args: string[] } {
  return agentSdkLaunchSpecWith(defaultEnv());
}

/**
 * Resolve the directory containing shipped MCP config stubs
 * (`mcp-configs/<name>.json`). Used to look up runtime-declared MCP entries
 * by short name (e.g. `mcp_servers: [jira]`).
 *
 * Installed tarball layout:   `<prefix>/mcp-configs/`
 * Source-tree layout:         `<repo>/mcp-configs/`
 */
export function resolveMcpConfigsDirWith(env: ResolveEnv): string {
  return join(resolveStoreBaseDirWith(env), "mcp-configs");
}

export function resolveMcpConfigsDir(): string {
  return resolveMcpConfigsDirWith(defaultEnv());
}

/**
 * Locate the vendored `codebase-memory-mcp` binary.
 *
 * codebase-memory-mcp is a static C binary distributed as a GitHub release
 * asset by DeusData. Vendored into the Ark bundle via
 * scripts/vendor-codebase-memory-mcp.sh + vendor/versions.yaml.
 *
 * Speaks MCP over stdio when invoked with no args. Agents receive it as
 * an MCP server entry in their .mcp.json at dispatch time.
 */

import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { logDebug } from "../observability/structured-log.js";

/**
 * Find the codebase-memory-mcp binary. Search order:
 * 1. bin/codebase-memory-mcp next to the ark binary (packaged distribution)
 * 2. dist/vendor/codebase-memory-mcp-<platform> relative to this source file's
 *    repo root (dev mode, after `make vendor-codebase-memory-mcp`)
 * 3. codebase-memory-mcp in PATH (global install via `brew` / manual)
 *
 * Mirrors the dev-vs-packaged split used by `install-paths.ts` -- `process.execPath`
 * is reliable in compiled Bun binaries; `import.meta.url` works in dev source tree
 * but is meaningless in compiled mode (virtual FS).
 */
export function findCodebaseMemoryBinary(): string {
  // Packaged distribution: bin/<name> next to the ark binary
  const arkBin = process.execPath;
  if (arkBin) {
    const vendored = join(dirname(arkBin), "codebase-memory-mcp");
    if (existsSync(vendored)) return vendored;
  }

  // Dev mode: walk up from this source file to the repo root (3 levels:
  // knowledge/ -> core/ -> packages/ -> repo-root) then look in dist/vendor/.
  const platform = detectPlatform();
  if (platform) {
    try {
      const repoRoot = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");
      const devVendor = join(repoRoot, "dist", "vendor", `codebase-memory-mcp-${platform}`);
      if (existsSync(devVendor)) return devVendor;
    } catch {
      logDebug("session", "import.meta.url unavailable (compiled bundle uses virtual FS) -- fall through");
    }
  }

  // Fall back to PATH
  return "codebase-memory-mcp";
}

/**
 * Check if codebase-memory-mcp is available (binary exists and responds).
 */
export function isCodebaseMemoryAvailable(): boolean {
  const bin = findCodebaseMemoryBinary();
  return bin !== "codebase-memory-mcp" || !!process.env.PATH;
}

function detectPlatform(): string | null {
  const os = process.platform;
  const arch = process.arch;
  if (os === "darwin" && arch === "arm64") return "darwin-arm64";
  if (os === "darwin" && arch === "x64") return "darwin-amd64";
  if (os === "linux" && arch === "arm64") return "linux-arm64";
  if (os === "linux" && arch === "x64") return "linux-amd64";
  return null;
}

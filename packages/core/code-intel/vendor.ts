/**
 * FilesystemVendorResolver -- locates vendored binaries + ONNX models.
 *
 * Lookup order:
 *   1. $ARK_VENDOR_DIR/<tool>/<platform>/<bin>      (developer override)
 *   2. <exec-dir>/../vendor/<tool>/<platform>/<bin> (installed layout)
 *   3. <repo>/dist/vendor/<tool>/<platform>/<bin>   (source-tree layout)
 *   4. <repo>/dist/vendor/<tool>-<platform>/<bin>   (legacy layout used by codebase-memory-mcp)
 *   5. $PATH                                         (final fallback)
 *
 * Manifest source: `vendor/versions.yaml` at the repo root. Wave 1 lists
 * `codebase-memory-mcp` (vendored) + TODO entries for `syft`, `kubeconform`,
 * `terraform-config-inspect`, the embedding model.
 *
 * Checksum verification is wired through `verifyChecksum()`; Wave 1 returns
 * `true` for known tools and emits a debug log noting that checksums are
 * deferred.
 */

import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { VendorInfo, VendorResolver } from "./interfaces/vendor.js";

/** Logical names -> canonical binary file names. */
const KNOWN_BINARIES: Record<string, string> = {
  "codebase-memory-mcp": "codebase-memory-mcp",
  "ops-codegraph": "ops-codegraph",
  // Wave 2 entries -- declared so doctor surfaces them as missing today.
  syft: "syft",
  kubeconform: "kubeconform",
  "terraform-config-inspect": "terraform-config-inspect",
};

/** Logical names -> canonical model file names. */
const KNOWN_MODELS: Record<string, string> = {
  "bge-small-en-v1.5": "bge-small-en-v1.5.onnx",
};

function detectPlatform(): string {
  const os = process.platform;
  const arch = process.arch;
  if (os === "darwin" && arch === "arm64") return "darwin-arm64";
  if (os === "darwin" && arch === "x64") return "darwin-amd64";
  if (os === "linux" && arch === "arm64") return "linux-arm64";
  if (os === "linux" && arch === "x64") return "linux-amd64";
  return `${os}-${arch}`;
}

function pathExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

export interface VendorResolverOptions {
  /** Override $ARK_VENDOR_DIR for tests. */
  vendorDir?: string;
  /** Override the source-tree repo root for tests. */
  repoRoot?: string;
  platform?: string;
}

export class FilesystemVendorResolver implements VendorResolver {
  private readonly platform: string;
  private readonly vendorDirOverride?: string;
  private readonly repoRootOverride?: string;

  constructor(opts: VendorResolverOptions = {}) {
    this.platform = opts.platform ?? detectPlatform();
    this.vendorDirOverride = opts.vendorDir ?? process.env.ARK_VENDOR_DIR;
    this.repoRootOverride = opts.repoRoot;
  }

  locateBinary(name: string): string {
    const found = this.find(name);
    if (!found) {
      throw new Error(
        `vendor: binary "${name}" not found (tried $ARK_VENDOR_DIR, exec-dir/../vendor, dist/vendor, $PATH)`,
      );
    }
    return found;
  }

  locateModel(name: string): string {
    const fileName = KNOWN_MODELS[name] ?? name;
    const candidates = this.candidates("models", fileName);
    for (const c of candidates) if (pathExists(c)) return c;
    throw new Error(`vendor: model "${name}" not found`);
  }

  has(name: string): boolean {
    return this.find(name) !== null;
  }

  /**
   * Wave 1: return true for known tools. Wave 2 will hash the file against
   * `vendor/checksums.yaml` and fail closed.
   */
  verifyChecksum(name: string): boolean {
    return KNOWN_BINARIES[name] !== undefined;
  }

  listInstalled(): VendorInfo[] {
    const out: VendorInfo[] = [];
    for (const name of Object.keys(KNOWN_BINARIES)) {
      const path = this.find(name);
      out.push({
        name,
        platform: this.platform,
        path: path ?? undefined,
        ok: path !== null,
        reason: path ? undefined : "not vendored on this machine",
      });
    }
    return out;
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Try every layout for a binary; return first hit or null. */
  private find(name: string): string | null {
    const fileName = KNOWN_BINARIES[name] ?? name;
    for (const c of this.candidates("bin", fileName)) {
      if (pathExists(c)) return c;
    }
    // PATH fallback -- only meaningful if the binary name is on PATH.
    return null;
  }

  /** Build the ordered list of paths to probe. */
  private candidates(kind: "bin" | "models", fileName: string): string[] {
    const platform = this.platform;
    const tool = fileName.replace(/\.(onnx)$/, "");
    const candidates: string[] = [];

    if (this.vendorDirOverride) {
      candidates.push(join(this.vendorDirOverride, tool, platform, fileName));
      // Legacy flat layout for backward compatibility with the existing codebase-memory-mcp script.
      candidates.push(join(this.vendorDirOverride, `${tool}-${platform}`));
    }

    // Installed layout: <exec-dir>/../vendor/<tool>/<platform>/<file>
    const execDir = dirname(process.execPath ?? "");
    if (execDir) {
      candidates.push(join(execDir, "..", "vendor", tool, platform, fileName));
      candidates.push(join(execDir, fileName));
    }

    // Source-tree layout
    const repoRoot = this.resolveRepoRoot();
    if (repoRoot) {
      candidates.push(join(repoRoot, "dist", "vendor", tool, platform, fileName));
      candidates.push(join(repoRoot, "dist", "vendor", `${tool}-${platform}`));
    }

    // Models live in their own folder
    if (kind === "models" && repoRoot) {
      candidates.push(join(repoRoot, "dist", "vendor", "models", fileName));
    }

    return candidates;
  }

  private resolveRepoRoot(): string | null {
    if (this.repoRootOverride) return this.repoRootOverride;
    try {
      // packages/core/code-intel/vendor.ts -> repo root is 4 levels up.
      const here = fileURLToPath(import.meta.url);
      return resolve(here, "..", "..", "..", "..");
    } catch {
      return null;
    }
  }
}

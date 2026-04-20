/**
 * VendorResolver -- locates vendored binaries, ONNX models, and checksums.
 *
 * Vendored local mode (no internet post-install) depends on this surface
 * finding every tool the pipeline needs. Control-plane mode uses the same
 * interface but resolves to in-image paths.
 *
 * Lookup order (FilesystemVendorResolver):
 *   1. $ARK_VENDOR_DIR/<tool>/<platform>/<bin>   (developer override)
 *   2. <exec-dir>/../vendor/<tool>/<platform>/<bin>  (installed layout)
 *   3. <repo>/dist/vendor/<tool>/<platform>/<bin>    (source-tree layout)
 *   4. $PATH                                          (final fallback)
 *
 * Example:
 *   const v: VendorResolver = new FilesystemVendorResolver();
 *   const syftPath = v.locateBinary("syft"); // throws if missing
 */

export interface VendorInfo {
  name: string;
  version?: string;
  platform: string;
  path?: string;
  ok: boolean;
  reason?: string;
}

export interface VendorResolver {
  /** Throws if the named binary cannot be resolved. */
  locateBinary(name: string): string;
  /** Throws if the named ONNX model cannot be resolved. */
  locateModel(name: string): string;
  /** Verify SHA256 against the shipped manifest. Wave 1: stub returns true. */
  verifyChecksum(name: string): boolean;
  /** Roll-up for `ark doctor` / `ark code-intel doctor`. */
  listInstalled(): VendorInfo[];
  /** Non-throwing existence check. */
  has(name: string): boolean;
}

/**
 * Shared helpers for the blob-secret surface (multi-file named secrets).
 *
 * The actual storage lives in `file-provider.ts` and `aws-provider.ts`; this
 * module is the neutral ground where both providers + the dispatch path
 * share utility types and normalization logic. Keeping the helpers here
 * means the dispatch-time consumer (session dispatch on k8s) never has to
 * import a specific provider to materialize a k8s Secret from a blob.
 *
 * A blob is a flat map of filename -> bytes. There is no nesting -- by
 * design, so the underlying backends don't have to think about path
 * separators, and the destination (k8s Secret data entries, `~/.claude/`
 * directory) is also flat.
 */

import { assertValidBlobFilename } from "./types.js";

/** Logical shape of a blob accepted by `setBlob` (string or raw bytes per file). */
export type BlobInput = Record<string, Uint8Array | string>;

/** Fully-materialized blob as returned by `getBlob` (bytes per file). */
export type BlobBytes = Record<string, Uint8Array>;

/**
 * Coerce a blob input (string values allowed) to a bytes-only shape.
 * Validates every filename. Throws on a non-string / non-bytes value so a
 * typo like `{ foo: 123 }` is caught at the boundary.
 */
export function normalizeBlob(files: BlobInput): BlobBytes {
  if (!files || typeof files !== "object") {
    throw new Error("Blob input must be a Record<string, Uint8Array | string>");
  }
  const out: BlobBytes = {};
  const names = Object.keys(files);
  if (names.length === 0) {
    throw new Error("Blob must contain at least one file");
  }
  for (const filename of names) {
    assertValidBlobFilename(filename);
    const v = files[filename];
    if (typeof v === "string") {
      out[filename] = new TextEncoder().encode(v);
    } else if (v instanceof Uint8Array) {
      // Copy to detach from caller-owned buffer; cheap and the blobs we
      // handle are small (credential files, kilobytes).
      out[filename] = new Uint8Array(v);
    } else if (v && typeof (v as { byteLength?: number }).byteLength === "number") {
      // Node's Buffer is a Uint8Array but `instanceof Uint8Array` is true
      // in Bun; other Buffer-like shapes fall here for belt-and-braces.
      out[filename] = new Uint8Array(v as ArrayLike<number>);
    } else {
      throw new Error(`Blob file '${filename}': value must be a string or Uint8Array`);
    }
  }
  return out;
}

/** Total size of a materialized blob across every file. */
export function blobBytes(blob: BlobBytes): number {
  let total = 0;
  for (const k of Object.keys(blob)) total += blob[k].byteLength;
  return total;
}

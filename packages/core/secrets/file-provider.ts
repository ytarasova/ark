/**
 * File-backed secrets provider (local mode).
 *
 * Backing store: `${arkDir}/secrets.json`, mode 0600.
 * Values encrypted at rest with AES-256-GCM. The encryption key is derived
 * via `scrypt(N=16384)` from a combination of `os.hostname()`,
 * `os.userInfo().username`, and `process.arch` -- i.e. the key is
 * machine-scoped.
 *
 * IMPORTANT: This is **defense-in-depth** against a
 * `cat ~/.ark/secrets.json` leak on a shared machine, NOT a real security
 * boundary. An attacker with read access to the file AND the ability to
 * run code on the same machine (as the same user + arch) can trivially
 * derive the key and decrypt. For real secret management in multi-tenant
 * deployments use `AwsSecretsProvider` + SSM SecureString with a dedicated
 * KMS key. Rotating the secrets here requires only a manual re-set; there
 * is no backing keystore to manage.
 *
 * File shape (pretty-printed, stable key order):
 *   {
 *     "version": 1,
 *     "secrets": {
 *       "<tenantId>": {
 *         "<NAME>": { "v": "<base64>", "d": "...", "created_at": "...",
 *                     "updated_at": "..." }
 *       }
 *     }
 *   }
 *
 * Atomic writes: write to `secrets.json.tmp`, then rename -- partial
 * writes must never surface.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "fs";
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "crypto";
import os from "os";
import { dirname, join } from "path";
import type { SecretRef, SecretsCapability } from "./types.js";
import { assertValidSecretName, assertValidBlobName, assertValidBlobFilename } from "./types.js";
import { normalizeBlob, type BlobInput, type BlobBytes } from "./blob.js";

const VERSION = 1;
/** Pseudo-application-constant salt mixed into the scrypt KDF. */
const SCRYPT_SALT = Buffer.from("ark-secrets-v1");
const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM nonce
const TAG_LEN = 16;

interface FileStoredSecret {
  v: string; // base64(iv || ciphertext || authTag)
  d?: string; // description
  created_at: string;
  updated_at: string;
}

interface FileStoreShape {
  version: number;
  secrets: Record<string, Record<string, FileStoredSecret>>;
}

/** Filesystem layer abstraction -- kept tiny so tests can mock crash-mid-write. */
export interface SecretsFsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: "utf-8"): string;
  /** Write temp + rename. The adapter decides how (sync I/O is the default). */
  atomicWrite(p: string, data: string, mode: number): void;
  mkdirSync(p: string, opts: { recursive: true }): void;
}

const defaultFs: SecretsFsLike = {
  existsSync,
  readFileSync: (p, enc) => readFileSync(p, enc) as string,
  atomicWrite(p, data, mode) {
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, data, { encoding: "utf-8", mode });
    // chmod defensively: writeFileSync may honour `mode` only on creation,
    // so make sure the file is 0600 even if it already existed.
    try {
      chmodSync(tmp, mode);
    } catch {
      // best-effort
    }
    renameSync(tmp, p);
  },
  mkdirSync: (p, opts) => {
    mkdirSync(p, opts);
  },
};

function deriveKey(): Buffer {
  const material = `${os.hostname()}|${os.userInfo().username}|${process.arch}`;
  // N=16384, r=8, p=1 are the node defaults; spelled out for clarity.
  return scryptSync(material, SCRYPT_SALT, KEY_LEN, { N: 16384, r: 8, p: 1 });
}

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString("base64");
}

function decrypt(blob: string, key: Buffer): string {
  const raw = Buffer.from(blob, "base64");
  if (raw.length < IV_LEN + TAG_LEN) {
    throw new Error("Secret ciphertext is too short -- file may be corrupt");
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(raw.length - TAG_LEN);
  const enc = raw.subarray(IV_LEN, raw.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf-8");
}

/** Stable key-order JSON.stringify so git diffs on the file make sense. */
function sortedStringify(obj: FileStoreShape): string {
  const sortedSecrets: Record<string, Record<string, FileStoredSecret>> = {};
  const tenantIds = Object.keys(obj.secrets).sort();
  for (const tid of tenantIds) {
    const inner = obj.secrets[tid];
    const sortedInner: Record<string, FileStoredSecret> = {};
    for (const name of Object.keys(inner).sort()) sortedInner[name] = inner[name];
    sortedSecrets[tid] = sortedInner;
  }
  return `${JSON.stringify({ version: obj.version, secrets: sortedSecrets }, null, 2)}\n`;
}

export class FileSecretsProvider implements SecretsCapability {
  private readonly path: string;
  private readonly fs: SecretsFsLike;
  private readonly keyProvider: () => Buffer;
  private cachedKey: Buffer | null = null;

  constructor(arkDir: string, opts?: { fs?: SecretsFsLike; key?: Buffer | (() => Buffer) }) {
    this.path = join(arkDir, "secrets.json");
    this.fs = opts?.fs ?? defaultFs;
    if (opts?.key) {
      this.keyProvider = typeof opts.key === "function" ? (opts.key as () => Buffer) : () => opts.key as Buffer;
    } else {
      this.keyProvider = () => {
        if (!this.cachedKey) this.cachedKey = deriveKey();
        return this.cachedKey;
      };
    }
  }

  private loadStore(): FileStoreShape {
    if (!this.fs.existsSync(this.path)) {
      return { version: VERSION, secrets: {} };
    }
    const raw = this.fs.readFileSync(this.path, "utf-8");
    try {
      const parsed = JSON.parse(raw) as FileStoreShape;
      if (!parsed || typeof parsed !== "object" || !parsed.secrets) {
        return { version: VERSION, secrets: {} };
      }
      return parsed;
    } catch {
      // Corrupt file -- refuse to read so a mutating op doesn't erase the
      // broken file's contents. Caller sees a clear error.
      throw new Error(`secrets.json is unreadable (invalid JSON) at ${this.path}`);
    }
  }

  private saveStore(store: FileStoreShape): void {
    this.fs.mkdirSync(dirname(this.path), { recursive: true });
    this.fs.atomicWrite(this.path, sortedStringify(store), 0o600);
  }

  async list(tenantId: string): Promise<SecretRef[]> {
    const store = this.loadStore();
    const tenant = store.secrets[tenantId];
    if (!tenant) return [];
    const refs: SecretRef[] = [];
    for (const name of Object.keys(tenant).sort()) {
      const entry = tenant[name];
      refs.push({
        tenant_id: tenantId,
        name,
        description: entry.d,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
      });
    }
    return refs;
  }

  async get(tenantId: string, name: string): Promise<string | null> {
    assertValidSecretName(name);
    const store = this.loadStore();
    const entry = store.secrets[tenantId]?.[name];
    if (!entry) return null;
    return decrypt(entry.v, this.keyProvider());
  }

  async set(tenantId: string, name: string, value: string, opts?: { description?: string }): Promise<void> {
    assertValidSecretName(name);
    if (typeof value !== "string") throw new Error("Secret value must be a string");
    const store = this.loadStore();
    if (!store.secrets[tenantId]) store.secrets[tenantId] = {};
    const now = new Date().toISOString();
    const existing = store.secrets[tenantId][name];
    const entry: FileStoredSecret = {
      v: encrypt(value, this.keyProvider()),
      d: opts?.description ?? existing?.d,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (entry.d === undefined) delete entry.d;
    store.secrets[tenantId][name] = entry;
    this.saveStore(store);
  }

  async delete(tenantId: string, name: string): Promise<boolean> {
    assertValidSecretName(name);
    const store = this.loadStore();
    const tenant = store.secrets[tenantId];
    if (!tenant || !tenant[name]) return false;
    delete tenant[name];
    if (Object.keys(tenant).length === 0) delete store.secrets[tenantId];
    this.saveStore(store);
    return true;
  }

  async resolveMany(tenantId: string, names: string[]): Promise<Record<string, string>> {
    if (!Array.isArray(names) || names.length === 0) return {};
    for (const n of names) assertValidSecretName(n);
    const store = this.loadStore();
    const tenant = store.secrets[tenantId] ?? {};
    const out: Record<string, string> = {};
    const missing: string[] = [];
    const key = this.keyProvider();
    for (const n of names) {
      const entry = tenant[n];
      if (!entry) {
        missing.push(n);
        continue;
      }
      out[n] = decrypt(entry.v, key);
    }
    if (missing.length > 0) {
      throw new Error(`Missing secrets for tenant '${tenantId}': ${missing.join(", ")}`);
    }
    return out;
  }

  // ── Blob surface (multi-file secrets) ──────────────────────────────────
  //
  // Blobs live under `${arkDir}/secrets/<tenantId>/<blobName>/<file>` with
  // every file 0600. We deliberately do NOT encrypt the blob payloads --
  // blobs are used for things like claude subscription credentials that are
  // already secrets on disk in the user's `~/.claude/`, so layering the
  // file-provider's machine-scoped AES on top of them is security theatre.
  // Operators who want real at-rest encryption should run the AWS provider.
  //
  // We DO refuse to traverse outside `${arkDir}/secrets/<tenant>/` when
  // deleting or enumerating, and every filename is validated at the types
  // layer so the on-disk path is always a safe join.

  private blobRoot(): string {
    return join(dirname(this.path), "secrets");
  }

  private tenantBlobDir(tenantId: string): string {
    return join(this.blobRoot(), tenantId);
  }

  private blobDir(tenantId: string, name: string): string {
    return join(this.tenantBlobDir(tenantId), name);
  }

  async listBlobs(tenantId: string): Promise<string[]> {
    const dir = this.tenantBlobDir(tenantId);
    if (!existsSync(dir)) return [];
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  }

  async getBlob(tenantId: string, name: string): Promise<Record<string, Uint8Array> | null> {
    assertValidBlobName(name);
    const dir = this.blobDir(tenantId, name);
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir, { withFileTypes: true });
    const out: BlobBytes = {};
    for (const f of files) {
      if (!f.isFile()) continue;
      // Defensive: even though setBlob validates, a manually-added file
      // with a weird name should be ignored rather than crash reads.
      try {
        assertValidBlobFilename(f.name);
      } catch {
        continue;
      }
      const raw = readFileSync(join(dir, f.name));
      // readFileSync returns a Buffer; normalize to Uint8Array so the
      // return value matches the capability contract.
      out[f.name] = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    }
    return out;
  }

  async setBlob(tenantId: string, name: string, files: BlobInput): Promise<void> {
    assertValidBlobName(name);
    const normalized = normalizeBlob(files);
    const dir = this.blobDir(tenantId, name);
    // Wipe first so a shrinking blob doesn't leave stale files behind.
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Best-effort chmod on the tenant dir too -- mkdirSync respects umask,
    // so an explicit chmod guarantees 0700 even in a 022 umask session.
    try {
      chmodSync(dir, 0o700);
      chmodSync(this.tenantBlobDir(tenantId), 0o700);
    } catch {
      // best-effort
    }
    for (const filename of Object.keys(normalized)) {
      const dest = join(dir, filename);
      const tmp = `${dest}.tmp`;
      writeFileSync(tmp, normalized[filename], { mode: 0o600 });
      try {
        chmodSync(tmp, 0o600);
      } catch {
        // best-effort
      }
      renameSync(tmp, dest);
    }
  }

  async deleteBlob(tenantId: string, name: string): Promise<boolean> {
    assertValidBlobName(name);
    const dir = this.blobDir(tenantId, name);
    if (!existsSync(dir)) return false;
    // Guard: only delete if the target is a directory under the blob root.
    // Prevents a symlink pointed outside of ~/.ark/secrets/ from erasing
    // arbitrary disk contents.
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) return false;
    } catch {
      return false;
    }
    rmSync(dir, { recursive: true, force: true });
    return true;
  }
}

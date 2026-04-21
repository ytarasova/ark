/**
 * Tests for the file-backed secrets provider.
 *
 * Each test file boots a per-test temporary arkDir so parallel workers
 * don't share files. The provider uses an injected key + injected fs
 * adapter where relevant; we keep the default crypto path so the
 * encrypt/decrypt round-trip is exercised end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, renameSync, chmodSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileSecretsProvider, type SecretsFsLike } from "../file-provider.js";
import { assertValidSecretName } from "../types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ark-secrets-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileSecretsProvider", () => {
  it("round-trips set/get/list/delete for one tenant", async () => {
    const p = new FileSecretsProvider(dir);
    expect(await p.list("t1")).toEqual([]);
    await p.set("t1", "ANTHROPIC_API_KEY", "sk-abc", { description: "prod key" });
    await p.set("t1", "OPENAI_API_KEY", "sk-xyz");
    expect(await p.get("t1", "ANTHROPIC_API_KEY")).toBe("sk-abc");
    expect(await p.get("t1", "OPENAI_API_KEY")).toBe("sk-xyz");
    const refs = await p.list("t1");
    expect(refs.map((r) => r.name).sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    // refs should never leak a value field
    for (const r of refs) {
      expect((r as unknown as Record<string, unknown>).v).toBeUndefined();
      expect((r as unknown as Record<string, unknown>).value).toBeUndefined();
    }
    expect(refs.find((r) => r.name === "ANTHROPIC_API_KEY")?.description).toBe("prod key");
    const removed = await p.delete("t1", "OPENAI_API_KEY");
    expect(removed).toBe(true);
    expect(await p.get("t1", "OPENAI_API_KEY")).toBeNull();
    // Second delete is idempotent-false.
    expect(await p.delete("t1", "OPENAI_API_KEY")).toBe(false);
  });

  it("isolates tenants -- t1 FOO is not t2 FOO", async () => {
    const p = new FileSecretsProvider(dir);
    await p.set("t1", "FOO", "one");
    await p.set("t2", "FOO", "two");
    expect(await p.get("t1", "FOO")).toBe("one");
    expect(await p.get("t2", "FOO")).toBe("two");
    const t1Refs = await p.list("t1");
    const t2Refs = await p.list("t2");
    expect(t1Refs.map((r) => r.tenant_id)).toEqual(["t1"]);
    expect(t2Refs.map((r) => r.tenant_id)).toEqual(["t2"]);
    // Delete t1 FOO doesn't nuke t2 FOO.
    await p.delete("t1", "FOO");
    expect(await p.get("t1", "FOO")).toBeNull();
    expect(await p.get("t2", "FOO")).toBe("two");
  });

  it("rejects invalid secret names on set/get/delete", async () => {
    const p = new FileSecretsProvider(dir);
    for (const bad of ["lowercase", "has-dash", "has space", "", "UNI🎉CODE"]) {
      expect(() => assertValidSecretName(bad)).toThrow();
      await expect(p.set("t1", bad, "v")).rejects.toThrow(/Invalid secret name|non-empty/);
      await expect(p.get("t1", bad)).rejects.toThrow(/Invalid secret name|non-empty/);
      await expect(p.delete("t1", bad)).rejects.toThrow(/Invalid secret name|non-empty/);
    }
  });

  it("resolveMany throws with the full list of missing names when any are absent", async () => {
    const p = new FileSecretsProvider(dir);
    await p.set("t1", "FOO", "f");
    await p.set("t1", "BAR", "b");
    const resolved = await p.resolveMany("t1", ["FOO", "BAR"]);
    expect(resolved).toEqual({ FOO: "f", BAR: "b" });
    let err: Error | null = null;
    try {
      await p.resolveMany("t1", ["FOO", "MISSING_A", "MISSING_B"]);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("MISSING_A");
    expect(err!.message).toContain("MISSING_B");
    expect(err!.message).toContain("t1");
    // Value of FOO must never appear in the error surface.
    expect(err!.message).not.toContain('"f"');
  });

  it("atomic-write uses a .tmp file, renamed into place; mid-write crash preserves previous state", async () => {
    const p = new FileSecretsProvider(dir);
    await p.set("t1", "FOO", "v1"); // establish a baseline file
    const snapshot = readFileSync(join(dir, "secrets.json"), "utf-8");

    // Inject an fs adapter that crashes between tmp-write and rename.
    const crashingFs: SecretsFsLike = {
      existsSync,
      readFileSync: (p2, enc) => readFileSync(p2, enc) as string,
      mkdirSync: (p2, opts) => {
        mkdirSync(p2, opts);
      },
      atomicWrite: (p2, data, mode) => {
        const tmp = `${p2}.tmp`;
        writeFileSync(tmp, data, { encoding: "utf-8", mode });
        try {
          chmodSync(tmp, mode);
        } catch {
          /* best-effort */
        }
        // Simulate crash before rename.
        throw new Error("simulated crash before rename");
      },
    };
    const pCrash = new FileSecretsProvider(dir, { fs: crashingFs });
    await expect(pCrash.set("t1", "FOO", "v2")).rejects.toThrow(/simulated crash/);

    // secrets.json must still reflect the pre-crash value
    const after = readFileSync(join(dir, "secrets.json"), "utf-8");
    expect(after).toBe(snapshot);
    const tmpPath = join(dir, "secrets.json.tmp");
    if (existsSync(tmpPath)) {
      // tmp file is fine (and ignored) -- the important thing is the live
      // file wasn't clobbered. Clean up so the afterEach rm goes fast.
      rmSync(tmpPath);
    }

    // A fresh provider still reads "v1" back
    const pAfter = new FileSecretsProvider(dir);
    expect(await pAfter.get("t1", "FOO")).toBe("v1");
  });

  it("uses a tmp-then-rename sequence on happy path", async () => {
    const events: string[] = [];
    const recordingFs: SecretsFsLike = {
      existsSync,
      readFileSync: (p2, enc) => readFileSync(p2, enc) as string,
      mkdirSync: (p2, opts) => {
        mkdirSync(p2, opts);
      },
      atomicWrite: (p2, data, mode) => {
        const tmp = `${p2}.tmp`;
        events.push("write-tmp");
        writeFileSync(tmp, data, { encoding: "utf-8", mode });
        try {
          chmodSync(tmp, mode);
        } catch {
          /* best-effort */
        }
        events.push("rename");
        renameSync(tmp, p2);
      },
    };
    const p = new FileSecretsProvider(dir, { fs: recordingFs });
    await p.set("t1", "FOO", "v");
    expect(events).toEqual(["write-tmp", "rename"]);
  });
});

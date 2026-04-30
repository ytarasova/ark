import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileSecretsProvider } from "../file-provider.js";
import { __test_encrypt as encryptForTest } from "../file-provider.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ark-secrets-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileSecretsProvider v2", () => {
  test("reads legacy v1 file with type defaulting to env-var", async () => {
    const path = join(dir, "secrets.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        secrets: {
          default: {
            FOO: { v: encryptForTest("bar"), created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
          },
        },
      }),
    );
    const p = new FileSecretsProvider(dir);
    const refs = await p.list("default");
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe("FOO");
    expect(refs[0].type).toBe("env-var");
    expect(refs[0].metadata).toEqual({});
  });

  test("write -> read round-trip preserves type + metadata in v2 file", async () => {
    const p = new FileSecretsProvider(dir);
    await p.set("default", "BB_KEY", "PEM_BODY", {
      description: "bb deploy key",
      type: "ssh-private-key",
      metadata: { host: "bitbucket.org" },
    });
    // Reload to ensure persistence.
    const p2 = new FileSecretsProvider(dir);
    const refs = await p2.list("default");
    expect(refs[0].type).toBe("ssh-private-key");
    expect(refs[0].metadata).toEqual({ host: "bitbucket.org" });
    const value = await p2.get("default", "BB_KEY");
    expect(value).toBe("PEM_BODY");
    // File on disk is v2.
    const onDisk = JSON.parse(readFileSync(join(dir, "secrets.json"), "utf-8"));
    expect(onDisk.version).toBe(2);
  });

  test("set without type/metadata preserves existing typed-secret state", async () => {
    const p = new FileSecretsProvider(dir);
    await p.set("default", "K", "v1", {
      type: "ssh-private-key",
      metadata: { host: "bitbucket.org" },
    });
    // Now update the value/description without re-passing type/metadata.
    await p.set("default", "K", "v2", { description: "rotated" });
    const refs = await p.list("default");
    expect(refs[0].type).toBe("ssh-private-key");
    expect(refs[0].metadata).toEqual({ host: "bitbucket.org" });
    // Value also rotated.
    const value = await p.get("default", "K");
    expect(value).toBe("v2");
  });

  test("blob round-trip with type=generic-blob and target_path metadata", async () => {
    const p = new FileSecretsProvider(dir);
    await p.setBlob(
      "default",
      "claude",
      { ".credentials.json": "X" },
      {
        type: "generic-blob",
        metadata: { target_path: "~/.claude" },
      },
    );
    const refs = await p.listBlobsDetailed("default");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("generic-blob");
    expect(refs[0].metadata).toEqual({ target_path: "~/.claude" });
  });

  test("blob can contain a file named _meta.json without colliding with sidecar", async () => {
    const p = new FileSecretsProvider(dir);
    await p.setBlob(
      "default",
      "tricky",
      { "_meta.json": Buffer.from("user-content") },
      {
        type: "generic-blob",
        metadata: { target_path: "~/.tricky" },
      },
    );
    const blob = await p.getBlob("default", "tricky");
    expect(blob).not.toBeNull();
    expect(Buffer.from(blob!["_meta.json"]).toString()).toBe("user-content");
    // Sidecar still preserves the metadata.
    const refs = await p.listBlobsDetailed("default");
    expect(refs).toHaveLength(1);
    expect(refs[0].metadata).toEqual({ target_path: "~/.tricky" });
  });
});

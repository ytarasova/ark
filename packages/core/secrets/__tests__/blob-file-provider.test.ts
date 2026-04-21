/**
 * Tests for the blob (multi-file) surface on FileSecretsProvider.
 *
 * Lives alongside the existing string-secret tests for the same backend;
 * the blob surface is a separate namespace under `<arkDir>/secrets/` so
 * the two can coexist without interference.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileSecretsProvider } from "../file-provider.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ark-blob-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileSecretsProvider blobs", () => {
  it("round-trips a 3-file blob via set / get / list / delete", async () => {
    const p = new FileSecretsProvider(dir);
    expect(await p.listBlobs("t1")).toEqual([]);

    const files = {
      ".credentials.json": '{"apiKey":"sk-abc"}',
      ".claude.json": "{}",
      "history.jsonl": "line1\nline2\n",
    };
    await p.setBlob("t1", "claude-subscription", files);

    const names = await p.listBlobs("t1");
    expect(names).toEqual(["claude-subscription"]);

    const blob = await p.getBlob("t1", "claude-subscription");
    expect(blob).not.toBeNull();
    expect(Object.keys(blob!).sort()).toEqual([".claude.json", ".credentials.json", "history.jsonl"]);
    const decoder = new TextDecoder();
    expect(decoder.decode(blob![".credentials.json"])).toBe(files[".credentials.json"]);
    expect(decoder.decode(blob!["history.jsonl"])).toBe(files["history.jsonl"]);

    // Delete and confirm gone.
    const removed = await p.deleteBlob("t1", "claude-subscription");
    expect(removed).toBe(true);
    expect(await p.listBlobs("t1")).toEqual([]);
    expect(await p.getBlob("t1", "claude-subscription")).toBeNull();
    // Second delete is idempotent-false.
    expect(await p.deleteBlob("t1", "claude-subscription")).toBe(false);
  });

  it("set replaces prior blob contents (files removed between writes don't linger)", async () => {
    const p = new FileSecretsProvider(dir);
    await p.setBlob("t1", "creds", { a: "one", b: "two" });
    await p.setBlob("t1", "creds", { a: "oneprime" });
    const blob = await p.getBlob("t1", "creds");
    expect(blob).not.toBeNull();
    expect(Object.keys(blob!)).toEqual(["a"]);
    expect(new TextDecoder().decode(blob!.a)).toBe("oneprime");
  });

  it("accepts Uint8Array inputs (binary-safe)", async () => {
    const p = new FileSecretsProvider(dir);
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
    await p.setBlob("t1", "bin", { "payload.bin": bytes });
    const blob = await p.getBlob("t1", "bin");
    expect(Array.from(blob!["payload.bin"])).toEqual([0x00, 0x01, 0x02, 0xff]);
  });

  it("isolates tenants", async () => {
    const p = new FileSecretsProvider(dir);
    await p.setBlob("t1", "x", { f: "ONE" });
    await p.setBlob("t2", "x", { f: "TWO" });
    expect(new TextDecoder().decode((await p.getBlob("t1", "x"))!.f)).toBe("ONE");
    expect(new TextDecoder().decode((await p.getBlob("t2", "x"))!.f)).toBe("TWO");
    await p.deleteBlob("t1", "x");
    expect(await p.getBlob("t1", "x")).toBeNull();
    expect(new TextDecoder().decode((await p.getBlob("t2", "x"))!.f)).toBe("TWO");
  });

  it("validates blob names + filenames", async () => {
    const p = new FileSecretsProvider(dir);
    await expect(p.setBlob("t1", "BadName", { a: "x" })).rejects.toThrow(/Invalid blob name/);
    await expect(p.setBlob("t1", "x/y", { a: "x" })).rejects.toThrow(/Invalid blob name/);
    await expect(p.setBlob("t1", "ok", { "../escape": "x" })).rejects.toThrow(/Invalid blob filename/);
    await expect(p.setBlob("t1", "ok", { "nested/path": "x" })).rejects.toThrow(/Invalid blob filename/);
  });

  it("empty blob throws", async () => {
    const p = new FileSecretsProvider(dir);
    await expect(p.setBlob("t1", "empty", {})).rejects.toThrow(/at least one file/);
  });

  it("listBlobs sorts ASCII; returns empty list for unknown tenant", async () => {
    const p = new FileSecretsProvider(dir);
    await p.setBlob("t1", "b-beta", { a: "x" });
    await p.setBlob("t1", "a-alpha", { a: "x" });
    expect(await p.listBlobs("t1")).toEqual(["a-alpha", "b-beta"]);
    expect(await p.listBlobs("no-such-tenant")).toEqual([]);
  });

  it("stores blob files under <arkDir>/secrets/<tenant>/<name>/ (observable layout)", async () => {
    const p = new FileSecretsProvider(dir);
    await p.setBlob("t1", "claude-sub", { foo: "bar" });
    const expectedDir = join(dir, "secrets", "t1", "claude-sub");
    expect(existsSync(expectedDir)).toBe(true);
    expect(readdirSync(expectedDir)).toEqual(["foo"]);
  });
});

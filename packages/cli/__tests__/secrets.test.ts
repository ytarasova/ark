/**
 * CLI integration tests for `ark secrets ...` subcommands.
 *
 * These exercise the action handlers directly (via the exported
 * `performSecretSet` / `performBlobUpload` helpers) rather than spawning
 * the full CLI subprocess -- the intent is to cover that the new --type
 * and --metadata flags propagate into `app.secrets.set` /
 * `app.secrets.setBlob`, and that listing / describing surfaces them.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AppContext } from "../../core/app.js";
import { setInProcessApp } from "../app-client.js";
import { performSecretSet, performBlobUpload } from "../commands/secrets.js";

let app: AppContext;
let tenantId: string;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setInProcessApp(app);
  tenantId = app.config.authSection.defaultTenant ?? "default";
});

afterAll(async () => {
  setInProcessApp(null);
  await app?.shutdown();
});

beforeEach(async () => {
  // Wipe between tests so each one sees an empty tenant.
  for (const r of await app.secrets.list(tenantId)) {
    await app.secrets.delete(tenantId, r.name);
  }
  for (const r of await app.secrets.listBlobsDetailed(tenantId)) {
    await app.secrets.deleteBlob(tenantId, r.name);
  }
});

describe("ark secrets set --type and --metadata", () => {
  test("stores type and metadata on the secret ref", async () => {
    await performSecretSet("BB_KEY", "PEM_BODY", {
      type: "ssh-private-key",
      metadata: { host: "bitbucket.org" },
    });
    const refs = await app.secrets.list(tenantId);
    const bb = refs.find((r) => r.name === "BB_KEY");
    expect(bb).toBeTruthy();
    expect(bb?.type).toBe("ssh-private-key");
    expect(bb?.metadata).toEqual({ host: "bitbucket.org" });
  });

  test("rejects an unknown --type value", async () => {
    await expect(
      performSecretSet("FOO", "v", { type: "not-a-type" as any, metadata: {} }),
    ).rejects.toThrow(/Invalid --type/);
  });

  test("defaults type to env-var when caller does not specify", async () => {
    await performSecretSet("FOO", "v", { type: "env-var", metadata: {} });
    const refs = await app.secrets.list(tenantId);
    expect(refs.find((r) => r.name === "FOO")?.type).toBe("env-var");
  });
});

describe("ark secrets blob upload --type and --metadata", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "ark-cli-blob-"));
    writeFileSync(join(tmp, ".credentials.json"), "{}");
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("stores type and metadata on the blob ref", async () => {
    const count = await performBlobUpload("claude", tmp, {
      type: "generic-blob",
      metadata: { target_path: "~/.claude" },
    });
    expect(count).toBe(1);
    const refs = await app.secrets.listBlobsDetailed(tenantId);
    const claude = refs.find((r) => r.name === "claude");
    expect(claude).toBeTruthy();
    expect(claude?.type).toBe("generic-blob");
    expect(claude?.metadata).toEqual({ target_path: "~/.claude" });
  });

  test("rejects an unknown --type value", async () => {
    await expect(
      performBlobUpload("nope", tmp, { type: "bogus" as any, metadata: {} }),
    ).rejects.toThrow(/Invalid --type/);
  });
});

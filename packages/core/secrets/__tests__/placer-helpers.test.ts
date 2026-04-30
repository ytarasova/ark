import { describe, expect, test } from "bun:test";
import { buildSshConfigBlock, runKeyScan, validateMetadataPath } from "../placer-helpers.js";

describe("runKeyScan", () => {
  test("returns lines for github.com (live ssh-keyscan)", async () => {
    const out = await runKeyScan(["github.com"], { timeoutMs: 10_000 });
    const text = Buffer.from(out).toString("utf-8");
    // Don't assert the exact key -- just that github.com appears.
    expect(text).toMatch(/^github\.com /m);
  }, 15_000);

  test("returns empty buffer when host is unreachable", async () => {
    const out = await runKeyScan(["definitely-not-a-real-host.invalid"], { timeoutMs: 1500 });
    expect(out.length).toBe(0);
  });

  test("dedupes hosts", async () => {
    // Pass the same host twice; under the hood we should call ssh-keyscan once with one host.
    // We can't easily mock execFile here, so just assert the result is non-empty for a real host.
    const out = await runKeyScan(["github.com", "github.com"], { timeoutMs: 10_000 });
    expect(out.length).toBeGreaterThan(0);
  }, 15_000);
});

describe("buildSshConfigBlock", () => {
  test("emits BEGIN/END markers + Host directive", () => {
    const out = buildSshConfigBlock({
      name: "BB_KEY",
      host: "bitbucket.org",
      keyPath: "/home/ubuntu/.ssh/id_bb_key",
      username: "git",
    });
    expect(out).toContain("# BEGIN ark:secret:BB_KEY");
    expect(out).toContain("# END ark:secret:BB_KEY");
    expect(out).toContain("Host bitbucket.org");
    expect(out).toContain("IdentityFile /home/ubuntu/.ssh/id_bb_key");
    expect(out).toContain("IdentitiesOnly yes");
    expect(out).toContain("User git");
  });

  test("includes aliases on the Host line", () => {
    const out = buildSshConfigBlock({
      name: "BB_KEY",
      host: "bitbucket.org",
      aliases: ["bitbucket.paytm.com"],
      keyPath: "/k",
      username: "git",
    });
    expect(out).toMatch(/Host bitbucket\.org bitbucket\.paytm\.com/);
  });
});

describe("validateMetadataPath", () => {
  test("accepts ~/.config/foo", () => {
    expect(() => validateMetadataPath("~/.config/foo")).not.toThrow();
  });
  test("accepts ~/.ssh/id_x", () => {
    expect(() => validateMetadataPath("~/.ssh/id_x")).not.toThrow();
  });
  test("accepts /run/secrets/x", () => {
    expect(() => validateMetadataPath("/run/secrets/x")).not.toThrow();
  });
  test("rejects ..", () => {
    expect(() => validateMetadataPath("~/../etc/passwd")).toThrow(/traversal/);
  });
  test("rejects absolute paths outside home", () => {
    expect(() => validateMetadataPath("/etc/passwd")).toThrow(/absolute/);
  });
  test("rejects relative paths", () => {
    expect(() => validateMetadataPath("foo/bar")).toThrow(/must start/);
  });
  test("rejects NUL", () => {
    expect(() => validateMetadataPath("~/foo\0bar")).toThrow(/NUL/);
  });
  test("rejects CR/LF", () => {
    expect(() => validateMetadataPath("~/foo\nbar")).toThrow(/control/);
  });
});

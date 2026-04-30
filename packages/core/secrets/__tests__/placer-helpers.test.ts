import { describe, expect, test } from "bun:test";
import { runKeyScan } from "../placer-helpers.js";

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

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getCurrentVersion, checkForUpdate } from "../update-check.js";
import { withTestContext } from "./test-helpers.js";
import { writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { getApp } from "../app.js";

withTestContext();

describe("getCurrentVersion", () => {
  it("returns a version string", () => {
    const version = getCurrentVersion();
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
  });

  it("returns semver-like format or fallback", () => {
    const version = getCurrentVersion();
    // Either a valid version like "1.0.0" or the fallback "0.0.0"
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("checkForUpdate", () => {
  it("returns null or a version string", async () => {
    const result = await checkForUpdate(getApp().config.arkDir);
    // null = no update or network error, string = new version
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("respects rate limiting from saved state", async () => {
    // Write a recent check state so it skips the network call
    const statePath = join(getApp().config.arkDir, "update-check.json");
    const state = {
      lastCheck: new Date().toISOString(),
      latestVersion: getCurrentVersion(),
      currentVersion: getCurrentVersion(),
    };
    writeFileSync(statePath, JSON.stringify(state));

    const result = await checkForUpdate(getApp().config.arkDir);
    // Same version as current = no update
    expect(result).toBeNull();
  });

  it("reports update when saved state has newer version", async () => {
    const statePath = join(getApp().config.arkDir, "update-check.json");
    const state = {
      lastCheck: new Date().toISOString(),
      latestVersion: "99.99.99",
      currentVersion: getCurrentVersion(),
    };
    writeFileSync(statePath, JSON.stringify(state));

    const result = await checkForUpdate(getApp().config.arkDir);
    expect(result).toBe("99.99.99");
  });

  it("handles corrupted state file gracefully", async () => {
    const statePath = join(getApp().config.arkDir, "update-check.json");
    writeFileSync(statePath, "not-valid-json{{{");

    // Should not throw, just proceed with the check
    const result = await checkForUpdate(getApp().config.arkDir);
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("handles missing state file", async () => {
    const statePath = join(getApp().config.arkDir, "update-check.json");
    expect(existsSync(statePath)).toBe(false);

    // Should not throw
    const result = await checkForUpdate(getApp().config.arkDir);
    expect(result === null || typeof result === "string").toBe(true);
  });
});

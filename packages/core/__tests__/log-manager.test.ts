import { describe, it, expect } from "bun:test";
import { truncateLog, logDir, cleanupLogs } from "../observability/log-manager.js";
import { getApp } from "../app.js";
import { withTestContext } from "./test-helpers.js";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

withTestContext();

describe("log manager", () => {
  it("truncateLog keeps last N lines", () => {
    const dir = logDir(getApp(), );
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "test.log");
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    writeFileSync(path, lines.join("\n"));

    truncateLog(path, 10);
    const content = readFileSync(path, "utf-8");
    const kept = content.split("\n");
    expect(kept.length).toBe(10);
    expect(kept[kept.length - 1]).toBe("line 99");
  });

  it("truncateLog skips files under limit", () => {
    const dir = logDir(getApp(), );
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "small.log");
    writeFileSync(path, "line1\nline2\nline3");

    truncateLog(path, 10);
    const content = readFileSync(path, "utf-8");
    expect(content).toBe("line1\nline2\nline3");
  });

  it("truncateLog handles missing file", () => {
    truncateLog("/tmp/nonexistent.log", 10);
    // Should not throw
  });
});

describe("cleanupLogs", () => {
  it("returns zeros when log directory does not exist", () => {
    const result = cleanupLogs(getApp(), );
    expect(result).toEqual({ truncated: 0, removed: 0 });
  });

  it("removes orphaned log files for sessions that no longer exist", () => {
    const dir = logDir(getApp(), );
    mkdirSync(dir, { recursive: true });

    // Create a session so we know its ID format
    const session = getApp().sessions.create({ summary: "keep me" });

    // Write a log for the real session and a fake one
    writeFileSync(join(dir, `ark-${session.id}.log`), "real log");
    writeFileSync(join(dir, `ark-s-deadbeef.log`), "orphan log");

    const result = cleanupLogs(getApp(), { removeOrphans: true });
    expect(result.removed).toBe(1);
    expect(existsSync(join(dir, `ark-${session.id}.log`))).toBe(true);
    expect(existsSync(join(dir, `ark-s-deadbeef.log`))).toBe(false);
  });

  it("truncates oversized log files", () => {
    const dir = logDir(getApp(), );
    mkdirSync(dir, { recursive: true });

    const session = getApp().sessions.create({ summary: "large log" });
    const logPath = join(dir, `ark-${session.id}.log`);

    // Create a file that's over 1MB (use small maxSizeMb for testing)
    const bigContent = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n");
    writeFileSync(logPath, bigContent);

    // Use tiny maxSizeMb so the file counts as oversized
    const result = cleanupLogs(getApp(), { maxSizeMb: 0.001, maxLines: 100, removeOrphans: false });
    expect(result.truncated).toBe(1);

    const after = readFileSync(logPath, "utf-8");
    const afterLines = after.split("\n");
    expect(afterLines.length).toBe(100);
  });
});

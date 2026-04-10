import { describe, it, expect, beforeEach } from "bun:test";
import { setLogLevel, setLogComponents, logInfo, logError } from "../observability/structured-log.js";
import { withTestContext } from "./test-helpers.js";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

withTestContext();

/** Read log entries from the JSONL file */
function readLogEntries(arkDir: string): any[] {
  const logFile = join(arkDir, "ark.jsonl");
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
}

/** Clear the log file so each test starts fresh */
function clearLog(arkDir: string): void {
  const logFile = join(arkDir, "ark.jsonl");
  writeFileSync(logFile, "", "utf-8");
}

describe("structured logging", () => {
  beforeEach(() => {
    setLogLevel("debug");
    setLogComponents(null);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getApp } = require("../app.js");
    clearLog(getApp().config.arkDir);
  });

  it("writes JSONL entries", () => {
    logInfo("session", "test message", { key: "value" });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getApp } = require("../app.js");
    const entries = readLogEntries(getApp().config.arkDir);
    expect(entries.length).toBeGreaterThan(0);
    const last = entries[entries.length - 1];
    expect(last.level).toBe("info");
    expect(last.component).toBe("session");
    expect(last.message).toBe("test message");
    expect(last.data.key).toBe("value");
  });

  it("respects log level filtering", () => {
    setLogLevel("error");
    logInfo("general", "should not appear");
    logError("general", "should appear");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getApp } = require("../app.js");
    const entries = readLogEntries(getApp().config.arkDir);
    // Only error-level entries should be written
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(e => e.level === "error")).toBe(true);
  });

  it("respects component filtering", () => {
    setLogComponents(["mcp"]);
    logInfo("session", "filtered out");
    logInfo("mcp", "allowed");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getApp } = require("../app.js");
    const entries = readLogEntries(getApp().config.arkDir);
    // Only mcp component entries should be written
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(e => e.component === "mcp")).toBe(true);
  });

  it("entries have timestamps", () => {
    logInfo("general", "timed");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getApp } = require("../app.js");
    const entries = readLogEntries(getApp().config.arkDir);
    expect(entries.length).toBeGreaterThan(0);
    const last = entries[entries.length - 1];
    expect(new Date(last.timestamp).getTime()).toBeGreaterThan(0);
  });
});

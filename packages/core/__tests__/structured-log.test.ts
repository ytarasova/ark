import { describe, it, expect, beforeEach } from "bun:test";
import { log, setLogLevel, setLogComponents, logInfo, logError } from "../structured-log.js";
import { withTestContext } from "./test-helpers.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

withTestContext();

describe("structured logging", () => {
  beforeEach(() => {
    setLogLevel("debug");
    setLogComponents(null);
  });

  it("writes JSONL entries", () => {
    logInfo("session", "test message", { key: "value" });
    const { getApp } = require("../app.js");
    const logFile = join(getApp().config.arkDir, "ark.jsonl");
    expect(existsSync(logFile)).toBe(true);
    const content = readFileSync(logFile, "utf-8").trim();
    const entry = JSON.parse(content.split("\n").pop()!);
    expect(entry.level).toBe("info");
    expect(entry.component).toBe("session");
    expect(entry.message).toBe("test message");
    expect(entry.data.key).toBe("value");
  });

  it("respects log level filtering", () => {
    setLogLevel("error");
    logInfo("general", "should not appear");
    logError("general", "should appear");
    const { getApp } = require("../app.js");
    const logFile = join(getApp().config.arkDir, "ark.jsonl");
    if (existsSync(logFile)) {
      const lines = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
      const entries = lines.map(l => JSON.parse(l));
      expect(entries.every(e => e.level === "error")).toBe(true);
    }
  });

  it("respects component filtering", () => {
    setLogComponents(["mcp"]);
    logInfo("session", "filtered out");
    logInfo("mcp", "allowed");
    const { getApp } = require("../app.js");
    const logFile = join(getApp().config.arkDir, "ark.jsonl");
    if (existsSync(logFile)) {
      const lines = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
      const entries = lines.map(l => JSON.parse(l));
      expect(entries.every(e => e.component === "mcp")).toBe(true);
    }
  });

  it("entries have timestamps", () => {
    logInfo("general", "timed");
    const { getApp } = require("../app.js");
    const logFile = join(getApp().config.arkDir, "ark.jsonl");
    const content = readFileSync(logFile, "utf-8").trim();
    const entry = JSON.parse(content.split("\n").pop()!);
    expect(new Date(entry.timestamp).getTime()).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from "bun:test";
import { truncateLog, logDir } from "../log-manager.js";
import { withTestContext } from "./test-helpers.js";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

withTestContext();

describe("log manager", () => {
  it("truncateLog keeps last N lines", () => {
    const dir = logDir();
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
    const dir = logDir();
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

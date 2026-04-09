import { describe, it, expect } from "bun:test";
import { exportSession, exportSessionToFile, importSessionFromFile } from "../session-share.js";
import { getApp } from "../app.js";
import { withTestContext } from "./test-helpers.js";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

withTestContext();

describe("session sharing", () => {
  it("exportSession returns session data", () => {
    const s = getApp().sessions.create({ summary: "export-test", repo: "/tmp/repo" });
    const exported = exportSession(getApp(),s.id);
    expect(exported).not.toBeNull();
    expect(exported!.version).toBe(1);
    expect(exported!.session.summary).toBe("export-test");
  });

  it("exportSession returns null for missing session", () => {
    expect(exportSession(getApp(),"nonexistent")).toBeNull();
  });

  it("importSessionFromFile creates a new session", () => {
    const s = getApp().sessions.create({ summary: "to-share", repo: "/tmp/repo" });
    const exported = exportSession(getApp(),s.id);

    const dir = mkdtempSync(join(tmpdir(), "ark-share-"));
    const filePath = join(dir, "session.json");
    writeFileSync(filePath, JSON.stringify(exported));

    const result = importSessionFromFile(getApp(),filePath);
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeDefined();

    const imported = getApp().sessions.get(result.sessionId!);
    expect(imported).not.toBeNull();
    expect(imported!.summary).toContain("[imported]");
    expect(imported!.summary).toContain("to-share");
  });

  it("importSessionFromFile rejects invalid file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ark-share-"));
    const filePath = join(dir, "bad.json");
    writeFileSync(filePath, "not json");
    const result = importSessionFromFile(getApp(),filePath);
    expect(result.ok).toBe(false);
  });

  it("exportSessionToFile writes to disk and is re-importable", () => {
    const s = getApp().sessions.create({ summary: "roundtrip test", repo: "/tmp/repo" });
    const dir = mkdtempSync(join(tmpdir(), "ark-export-"));
    const filePath = join(dir, "export.json");

    const ok = exportSessionToFile(getApp(),s.id, filePath);
    expect(ok).toBe(true);

    // Verify the file was created
    const content = JSON.parse(require("fs").readFileSync(filePath, "utf-8"));
    expect(content.version).toBe(1);
    expect(content.session.summary).toBe("roundtrip test");

    // Re-import it
    const result = importSessionFromFile(getApp(),filePath);
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeDefined();
  });

  it("exportSessionToFile returns false for missing session", () => {
    const dir = mkdtempSync(join(tmpdir(), "ark-export-"));
    const filePath = join(dir, "missing.json");

    const ok = exportSessionToFile(getApp(),"nonexistent", filePath);
    expect(ok).toBe(false);
  });
});

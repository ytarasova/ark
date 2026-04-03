import { describe, it, expect } from "bun:test";
import { exportSession, importSessionFromFile } from "../session-share.js";
import { createSession, getSession } from "../store.js";
import { withTestContext } from "./test-helpers.js";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

withTestContext();

describe("session sharing", () => {
  it("exportSession returns session data", () => {
    const s = createSession({ summary: "export-test", repo: "/tmp/repo" });
    const exported = exportSession(s.id);
    expect(exported).not.toBeNull();
    expect(exported!.version).toBe(1);
    expect(exported!.session.summary).toBe("export-test");
  });

  it("exportSession returns null for missing session", () => {
    expect(exportSession("nonexistent")).toBeNull();
  });

  it("importSessionFromFile creates a new session", () => {
    const s = createSession({ summary: "to-share", repo: "/tmp/repo" });
    const exported = exportSession(s.id);

    const dir = mkdtempSync(join(tmpdir(), "ark-share-"));
    const filePath = join(dir, "session.json");
    writeFileSync(filePath, JSON.stringify(exported));

    const result = importSessionFromFile(filePath);
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeDefined();

    const imported = getSession(result.sessionId!);
    expect(imported).not.toBeNull();
    expect(imported!.summary).toContain("[imported]");
    expect(imported!.summary).toContain("to-share");
  });

  it("importSessionFromFile rejects invalid file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ark-share-"));
    const filePath = join(dir, "bad.json");
    writeFileSync(filePath, "not json");
    const result = importSessionFromFile(filePath);
    expect(result.ok).toBe(false);
  });
});

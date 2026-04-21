import { describe, it, expect } from "bun:test";
import { exportSession, exportSessionToFile, importSessionFromFile } from "../session/share.js";
import { withTestContext } from "./test-helpers.js";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("session sharing", async () => {
  it("exportSession returns session data", async () => {
    const s = await getApp().sessions.create({ summary: "export-test", repo: "/tmp/repo" });
    const exported = await exportSession(getApp(), s.id);
    expect(exported).not.toBeNull();
    expect(exported!.version).toBe(1);
    expect(exported!.session.summary).toBe("export-test");
  });

  it("exportSession returns null for missing session", async () => {
    expect(await exportSession(getApp(), "nonexistent")).toBeNull();
  });

  it("importSessionFromFile creates a new session", async () => {
    const s = await getApp().sessions.create({ summary: "to-share", repo: "/tmp/repo" });
    const exported = await exportSession(getApp(), s.id);

    const dir = mkdtempSync(join(tmpdir(), "ark-share-"));
    const filePath = join(dir, "session.json");
    writeFileSync(filePath, JSON.stringify(exported));

    const result = await importSessionFromFile(getApp(), filePath);
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeDefined();

    const imported = await getApp().sessions.get(result.sessionId!);
    expect(imported).not.toBeNull();
    expect(imported!.summary).toContain("[imported]");
    expect(imported!.summary).toContain("to-share");
  });

  it("importSessionFromFile rejects invalid file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ark-share-"));
    const filePath = join(dir, "bad.json");
    writeFileSync(filePath, "not json");
    const result = await importSessionFromFile(getApp(), filePath);
    expect(result.ok).toBe(false);
  });

  it("exportSessionToFile writes to disk and is re-importable", async () => {
    const s = await getApp().sessions.create({ summary: "roundtrip test", repo: "/tmp/repo" });
    const dir = mkdtempSync(join(tmpdir(), "ark-export-"));
    const filePath = join(dir, "export.json");

    const ok = await exportSessionToFile(getApp(), s.id, filePath);
    expect(ok).toBe(true);

    // Verify the file was created
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const content = JSON.parse(require("fs").readFileSync(filePath, "utf-8"));
    expect(content.version).toBe(1);
    expect(content.session.summary).toBe("roundtrip test");

    // Re-import it
    const result = await importSessionFromFile(getApp(), filePath);
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeDefined();
  });

  it("exportSessionToFile returns false for missing session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ark-export-"));
    const filePath = join(dir, "missing.json");

    const ok = await exportSessionToFile(getApp(), "nonexistent", filePath);
    expect(ok).toBe(false);
  });
});

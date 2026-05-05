import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readLocalBearer, matchesLocalBearer } from "../local-bearer.js";

describe("readLocalBearer", () => {
  let arkDir: string;

  beforeEach(() => {
    arkDir = mkdtempSync(join(tmpdir(), "ark-local-bearer-"));
  });
  afterEach(() => {
    rmSync(arkDir, { recursive: true, force: true });
  });

  it("returns null when arkDir is null or undefined", () => {
    expect(readLocalBearer(null)).toBeNull();
    expect(readLocalBearer(undefined)).toBeNull();
  });

  it("returns null when arkd.token is missing", () => {
    expect(readLocalBearer(arkDir)).toBeNull();
  });

  it("returns null for empty / whitespace-only files", () => {
    writeFileSync(join(arkDir, "arkd.token"), "");
    expect(readLocalBearer(arkDir)).toBeNull();
    writeFileSync(join(arkDir, "arkd.token"), "   \n\t  \n");
    expect(readLocalBearer(arkDir)).toBeNull();
  });

  it("trims trailing newline / whitespace", () => {
    writeFileSync(join(arkDir, "arkd.token"), "abc-def-ghi\n");
    expect(readLocalBearer(arkDir)).toBe("abc-def-ghi");
  });

  it("returns null when the file is unreadable", () => {
    const path = join(arkDir, "arkd.token");
    writeFileSync(path, "value");
    chmodSync(path, 0o000);
    try {
      // On some CI environments the test may run as root, in which case the
      // chmod 0 doesn't block reads and we fall through to the trimmed value.
      // Either outcome is safe -- what we care about is that readLocalBearer
      // never throws.
      const result = readLocalBearer(arkDir);
      expect(result === null || result === "value").toBe(true);
    } finally {
      chmodSync(path, 0o600);
    }
  });
});

describe("matchesLocalBearer", () => {
  it("rejects on length mismatch", () => {
    expect(matchesLocalBearer("abc", "abcd")).toBe(false);
    expect(matchesLocalBearer("abcd", "abc")).toBe(false);
  });

  it("rejects on byte mismatch at equal length", () => {
    expect(matchesLocalBearer("abcd", "abce")).toBe(false);
  });

  it("accepts exact match", () => {
    expect(matchesLocalBearer("abcd", "abcd")).toBe(true);
  });

  it("rejects empty against non-empty", () => {
    expect(matchesLocalBearer("", "abc")).toBe(false);
    expect(matchesLocalBearer("abc", "")).toBe(false);
  });
});

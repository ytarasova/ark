/**
 * Deny-path tests for P1-3: attachment path traversal.
 *
 * The `safeAttachmentName` helper in packages/core/services/worktree/setup.ts
 * is the single sanitization choke-point for user-controlled attachment names.
 * These tests assert that every known traversal payload throws, and that safe
 * names round-trip untouched.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { safeAttachmentName } from "../../../core/services/worktree/index.js";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");

describe("safeAttachmentName -- rejects traversal payloads", () => {
  test("throws on ../../escape.txt", () => {
    expect(() => safeAttachmentName("../../escape.txt")).toThrow(/unsafe/);
  });

  test("throws on ..", () => {
    expect(() => safeAttachmentName("..")).toThrow(/unsafe/);
  });

  test("throws on ./file", () => {
    expect(() => safeAttachmentName("./file")).toThrow(/unsafe/);
  });

  test("throws on absolute posix path", () => {
    expect(() => safeAttachmentName("/etc/passwd")).toThrow(/unsafe/);
  });

  test("throws on path with forward slash", () => {
    expect(() => safeAttachmentName("subdir/file.txt")).toThrow(/unsafe/);
  });

  test("throws on path with backslash", () => {
    expect(() => safeAttachmentName("subdir\\file.txt")).toThrow(/unsafe/);
  });

  test("throws on Windows-style drive letter path", () => {
    expect(() => safeAttachmentName("C:\\Users\\x.txt")).toThrow(/unsafe/);
  });

  test("throws on empty string", () => {
    expect(() => safeAttachmentName("")).toThrow();
  });

  test("throws on lone dot", () => {
    expect(() => safeAttachmentName(".")).toThrow(/unsafe/);
  });

  test("throws on NUL byte", () => {
    expect(() => safeAttachmentName("file\0.txt")).toThrow(/unsafe/);
  });

  test("throws on newline", () => {
    expect(() => safeAttachmentName("file\n.txt")).toThrow(/unsafe/);
  });
});

describe("safeAttachmentName -- accepts safe leaf names", () => {
  test("plain filename passes through", () => {
    expect(safeAttachmentName("spec.md")).toBe("spec.md");
  });

  test("filename with spaces passes through", () => {
    expect(safeAttachmentName("my file.txt")).toBe("my file.txt");
  });

  test("filename with dots in middle passes through", () => {
    expect(safeAttachmentName("foo.bar.baz.tar.gz")).toBe("foo.bar.baz.tar.gz");
  });

  test("dotfile passes through", () => {
    expect(safeAttachmentName(".env.example")).toBe(".env.example");
  });
});

describe("worktree setup wires the helper into the attachment write path", () => {
  const src = readFileSync(join(ROOT, "packages/core/services/worktree/setup.ts"), "utf-8");

  test("export exists", () => {
    expect(src).toMatch(/export function safeAttachmentName/);
  });

  test("attachment write uses safeAttachmentName (not raw att.name)", () => {
    // The raw `att.name` must no longer be joined directly -- it must pass through
    // safeAttachmentName first. Regression guard: if someone re-introduces
    // `join(attachDir, att.name)` we want this test to fail.
    expect(src).not.toMatch(/join\(attachDir,\s*att\.name\)/);
    expect(src).toMatch(/safeName\s*=\s*safeAttachmentName\(att\.name\)/);
    expect(src).toMatch(/join\(attachDir,\s*safeName\)/);
  });
});

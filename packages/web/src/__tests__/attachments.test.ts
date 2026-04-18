/**
 * Tests for file attachment support.
 *
 * Verifies that:
 * - AttachmentInfo interface has content field in NewSessionModal
 * - MAX_FILE_SIZE is 500KB
 * - TEXT_EXTENSIONS set includes common extensions
 * - CreateSessionOpts in types/session.ts has attachments field
 * - session-orchestration.ts stores attachments in config
 * - session-orchestration.ts injects attachments into agent prompt (formatTaskHeader)
 * - session-orchestration.ts writes attachments to .ark/attachments/ directory
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const WEB_SRC = join(import.meta.dir, "..");

function readFile(path: string): string {
  return readFileSync(path, "utf-8");
}

describe("NewSessionModal attachment support", () => {
  const src = readFile(join(WEB_SRC, "components/NewSessionModal.tsx"));

  test("AttachmentInfo interface has content field", () => {
    expect(src).toContain("interface AttachmentInfo");
    expect(src).toContain("content?: string");
  });

  test("AttachmentInfo has name, size, type fields", () => {
    expect(src).toContain("name: string");
    expect(src).toContain("size: number");
    expect(src).toContain("type: string");
  });

  test("MAX_FILE_SIZE is 500KB (500 * 1024)", () => {
    expect(src).toContain("const MAX_FILE_SIZE = 500 * 1024");
  });

  test("TEXT_EXTENSIONS includes common code and config extensions", () => {
    const requiredExts = [
      ".md",
      ".txt",
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".py",
      ".yaml",
      ".yml",
      ".json",
      ".css",
      ".html",
    ];
    for (const ext of requiredExts) {
      expect(src).toContain(`"${ext}"`);
    }
  });

  test("TEXT_EXTENSIONS includes systems programming languages", () => {
    const sysExts = [".rs", ".go", ".java", ".c", ".h", ".cpp"];
    for (const ext of sysExts) {
      expect(src).toContain(`"${ext}"`);
    }
  });

  test("onSubmit payload includes attachments", () => {
    expect(src).toMatch(/onSubmit\(\{[\s\S]*?attachments/);
  });

  test("uses isTextFile helper to detect text content", () => {
    expect(src).toContain("function isTextFile");
    expect(src).toContain("TEXT_EXTENSIONS.has(ext)");
  });

  test("reads text files as text and binary files as data URLs", () => {
    expect(src).toContain("reader.readAsText(f)");
    expect(src).toContain("reader.readAsDataURL(f)");
  });
});

describe("CreateSessionOpts in types/session.ts", () => {
  const src = readFile(join(ROOT, "packages/types/session.ts"));

  test("has attachments field with name, content, type array", () => {
    expect(src).toContain("attachments?: Array<{ name: string; content: string; type: string }>");
  });
});

describe("session-orchestration attachment handling", () => {
  // Attachment storage logic is in session-lifecycle.ts, prompt formatting in task-builder.ts,
  // and worktree file materialization in workspace-service.ts (extracted from session-orchestration.ts).
  const lifecycleSrc = readFile(join(ROOT, "packages/core/services/session-lifecycle.ts"));
  const taskBuilderSrc = readFile(join(ROOT, "packages/core/services/task-builder.ts"));
  const worktreeSrc = readFile(join(ROOT, "packages/core/services/workspace-service.ts"));

  test("stores attachments in session config", () => {
    expect(lifecycleSrc).toContain("attachments: opts.attachments.map");
  });

  test("writes attachments to .ark/attachments/ directory", () => {
    expect(worktreeSrc).toContain('.ark", "attachments"');
    expect(worktreeSrc).toContain("mkdirSync(attachDir");
  });

  test("formatTaskHeader injects attachment info into agent prompt", () => {
    expect(taskBuilderSrc).toContain("## Attached Files");
    expect(taskBuilderSrc).toContain("Files are saved to `.ark/attachments/`");
  });

  test("handles binary files differently from text files in prompt", () => {
    // Binary files show path reference, text files show inline content
    expect(taskBuilderSrc).toContain('att.content?.startsWith("data:")');
    expect(taskBuilderSrc).toContain("Binary file");
  });
});

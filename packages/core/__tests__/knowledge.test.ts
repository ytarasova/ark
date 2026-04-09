/**
 * Tests for knowledge ingestion: chunkText, ingestFile, queryKnowledge.
 */

import { getApp } from "../app.js";
import { describe, it, expect } from "bun:test";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { ingestFile, ingestDirectory, queryKnowledge, chunkText } from "../knowledge.js";
import { clearMemories, listMemories } from "../memory.js";
import { withTestContext } from "./test-helpers.js";

const { getCtx } = withTestContext();

describe("chunkText", () => {
  it("splits text by paragraphs respecting word limit", () => {
    const text = "First paragraph with several words here.\n\nSecond paragraph also has words.\n\nThird paragraph.";
    const chunks = chunkText(text, 10);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // All original content should be present across chunks
    const joined = chunks.join(" ");
    expect(joined).toContain("First paragraph");
    expect(joined).toContain("Third paragraph");
  });

  it("keeps small text as single chunk", () => {
    const text = "Short text.";
    const chunks = chunkText(text, 500);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe("Short text.");
  });

  it("handles empty text", () => {
    const chunks = chunkText("", 100);
    expect(chunks.length).toBe(0);
  });
});

describe("ingestFile", () => {
  it("ingests a markdown file into memory", () => {
    const dir = getCtx().arkDir;
    const filePath = join(dir, "test-doc.md");
    writeFileSync(filePath, "# Guide\n\nThis is a test document about TypeScript configuration.\n\nIt has multiple paragraphs explaining important concepts about the build system.");

    const count = ingestFile(getApp(), filePath, { scope: "test", tags: ["docs"] });
    expect(count).toBeGreaterThanOrEqual(1);

    const memories = listMemories(getApp(),"test");
    expect(memories.length).toBeGreaterThanOrEqual(1);
    expect(memories.some(m => m.tags.includes("docs"))).toBe(true);
    expect(memories.some(m => m.tags.some(t => t.startsWith("file:")))).toBe(true);
  });

  it("returns 0 for nonexistent file", () => {
    expect(ingestFile(getApp(), "/nonexistent/file.md")).toBe(0);
  });

  it("returns 0 for unsupported extension", () => {
    const dir = getCtx().arkDir;
    const filePath = join(dir, "binary.exe");
    writeFileSync(filePath, "not really binary");
    expect(ingestFile(getApp(), filePath)).toBe(0);
  });

  it("skips tiny chunks under 20 chars", () => {
    const dir = getCtx().arkDir;
    const filePath = join(dir, "tiny.txt");
    writeFileSync(filePath, "ok");
    const count = ingestFile(getApp(), filePath);
    // "ok" is < 20 chars, so nothing should be ingested
    const memories = listMemories(getApp(),"knowledge");
    const fromFile = memories.filter(m => m.tags.some(t => t.includes("tiny.txt")));
    expect(fromFile.length).toBe(0);
  });
});

describe("ingestDirectory", () => {
  it("ingests supported files recursively", () => {
    const dir = getCtx().arkDir;
    const docsDir = join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });
    const subDir = join(docsDir, "guides");
    mkdirSync(subDir, { recursive: true });

    writeFileSync(join(docsDir, "readme.md"), "# Readme\n\nThis project readme contains important information about setup and configuration.");
    writeFileSync(join(subDir, "setup.txt"), "Setup guide with detailed instructions for installing dependencies and running the project locally.");
    writeFileSync(join(docsDir, "image.png"), "not a text file");

    const result = ingestDirectory(getApp(), docsDir, { scope: "test-dir" });
    expect(result.files).toBeGreaterThanOrEqual(2);
    expect(result.chunks).toBeGreaterThanOrEqual(2);
  });

  it("skips hidden directories and node_modules", () => {
    const dir = getCtx().arkDir;
    const root = join(dir, "project");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });

    writeFileSync(join(root, ".git", "config.txt"), "This is a git config file with important repository settings and configuration.");
    writeFileSync(join(root, "node_modules", "dep.txt"), "This is a dependency file that should not be ingested during directory scanning.");
    writeFileSync(join(root, "src", "code.md"), "# Source Code\n\nDocumentation for the source code including architecture and design patterns.");

    const result = ingestDirectory(getApp(), root, { scope: "test-skip" });
    expect(result.files).toBe(1);  // only src/code.md
  });

  it("returns zeros for nonexistent directory", () => {
    const result = ingestDirectory(getApp(), "/nonexistent/dir");
    expect(result).toEqual({ files: 0, chunks: 0 });
  });
});

describe("queryKnowledge", () => {
  it("queries ingested knowledge", () => {
    const dir = getCtx().arkDir;
    const filePath = join(dir, "knowledge-test.md");
    writeFileSync(filePath, "# Authentication\n\nThe authentication system uses JWT tokens for secure session management and API authorization.");

    ingestFile(getApp(), filePath, { scope: "knowledge" });

    const results = queryKnowledge(getApp(), "authentication JWT tokens");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain("authentication");
  });
});

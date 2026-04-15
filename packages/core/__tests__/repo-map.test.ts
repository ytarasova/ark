/**
 * Tests for repo map generation: scanning, export extraction, formatting, filtering.
 */

import { describe, it, expect } from "bun:test";
import { generateRepoMap, extractExports, formatRepoMap, SKIP_DIRS, CODE_EXTENSIONS } from "../repo-map.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ark-repo-map-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("generateRepoMap", () => {
  it("scans Ark's own codebase and finds TypeScript files", () => {
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    const map = generateRepoMap(repoRoot, { maxFiles: 100 });

    expect(map.root).toBe(repoRoot);
    expect(map.totalFiles).toBeGreaterThan(0);
    expect(map.entries.length).toBeGreaterThan(0);
    expect(map.summary.length).toBeGreaterThan(0);

    // Should find some .ts files
    const tsFiles = map.entries.filter((e) => e.path.endsWith(".ts"));
    expect(tsFiles.length).toBeGreaterThan(0);

    // Entries should be sorted by path
    for (let i = 1; i < map.entries.length; i++) {
      expect(map.entries[i].path >= map.entries[i - 1].path).toBe(true);
    }
  });

  it("respects maxFiles limit", () => {
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    const map = generateRepoMap(repoRoot, { maxFiles: 5 });
    expect(map.totalFiles).toBeLessThanOrEqual(5);
  });

  it("returns empty for nonexistent directory", () => {
    const map = generateRepoMap("/tmp/nonexistent-dir-12345");
    expect(map.totalFiles).toBe(0);
    expect(map.entries).toEqual([]);
  });
});

describe("extractExports", () => {
  it("extracts exported functions, classes, interfaces, types from .ts files", () => {
    const dir = makeTmpDir();
    const filePath = join(dir, "sample.ts");
    writeFileSync(
      filePath,
      `
export function doSomething() {}
export async function doAsync() {}
export class MyClass {}
export interface MyInterface {}
export type MyType = string;
export const MY_CONST = 42;
function privateFunc() {}
`,
    );

    const exports = extractExports(filePath, ".ts");
    expect(exports).toContain("doSomething");
    expect(exports).toContain("doAsync");
    expect(exports).toContain("MyClass");
    expect(exports).toContain("MyInterface");
    expect(exports).toContain("MyType");
    expect(exports).toContain("MY_CONST");
    expect(exports).not.toContain("privateFunc");
  });

  it("extracts Python defs and classes", () => {
    const dir = makeTmpDir();
    const filePath = join(dir, "sample.py");
    writeFileSync(
      filePath,
      `
def hello():
    pass

class World:
    pass
`,
    );

    const exports = extractExports(filePath, ".py");
    expect(exports).toContain("hello");
    expect(exports).toContain("World");
  });
});

describe("formatRepoMap", () => {
  it("formats entries as path: exports lines", () => {
    const entries = [
      { path: "src/a.ts", type: "file" as const, exports: ["foo", "bar"], size: 100 },
      { path: "src/b.ts", type: "file" as const, exports: [], size: 50 },
    ];

    const result = formatRepoMap(entries);
    expect(result).toContain("src/a.ts: foo, bar");
    expect(result).toContain("src/b.ts");
    expect(result).not.toContain("src/b.ts:");
  });

  it("truncates output when exceeding token budget", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      path: `src/file${i}.ts`,
      type: "file" as const,
      exports: ["longExportNameThatTakesSpace"],
      size: 1000,
    }));

    const result = formatRepoMap(entries, 50); // very small budget: 200 chars
    expect(result).toContain("... (truncated)");
    expect(result.length).toBeLessThan(300);
  });
});

describe("filtering", () => {
  it("SKIP_DIRS excludes node_modules, dist, .git etc", () => {
    expect(SKIP_DIRS.has("node_modules")).toBe(true);
    expect(SKIP_DIRS.has("dist")).toBe(true);
    expect(SKIP_DIRS.has(".git")).toBe(true);
    expect(SKIP_DIRS.has("src")).toBe(false);
  });

  it("CODE_EXTENSIONS includes common language extensions", () => {
    expect(CODE_EXTENSIONS.has(".ts")).toBe(true);
    expect(CODE_EXTENSIONS.has(".py")).toBe(true);
    expect(CODE_EXTENSIONS.has(".go")).toBe(true);
    expect(CODE_EXTENSIONS.has(".rs")).toBe(true);
    expect(CODE_EXTENSIONS.has(".md")).toBe(false);
    expect(CODE_EXTENSIONS.has(".json")).toBe(false);
  });
});

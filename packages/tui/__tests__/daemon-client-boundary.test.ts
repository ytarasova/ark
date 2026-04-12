/**
 * Daemon-client boundary test.
 *
 * Ensures no TUI source file (excluding tests and the legacy AppProvider)
 * imports getApp() from core. All data access must go through ArkClient RPC.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve, relative } from "path";

const TUI_DIR = resolve(import.meta.dir, "..");

function globTuiSources(): string[] {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const files: string[] = [];
  for (const path of glob.scanSync({ cwd: TUI_DIR, absolute: true })) {
    // Skip test files, legacy AppProvider (type-only import), and __tests__ dirs
    const rel = relative(TUI_DIR, path);
    if (rel.includes("__tests__")) continue;
    if (rel === "context/AppProvider.tsx") continue;
    files.push(path);
  }
  return files;
}

describe("daemon-client boundary", () => {
  it("no TUI source file imports getApp from core", () => {
    const violations: string[] = [];
    for (const file of globTuiSources()) {
      const content = readFileSync(file, "utf-8");
      for (const line of content.split("\n")) {
        // Skip comment-only lines
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        // Match: import { ... getApp ... } from "...core/app..."
        if (/import\s+\{[^}]*\bgetApp\b[^}]*\}\s+from\s+["'].*core\/app/.test(line)) {
          const rel = relative(TUI_DIR, file);
          violations.push(rel);
          break;
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no TUI source file calls getApp() in executable code", () => {
    const violations: string[] = [];
    for (const file of globTuiSources()) {
      const content = readFileSync(file, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/**")) continue;
        // Actual getApp() call in non-comment code
        if (/\bgetApp\s*\(/.test(trimmed)) {
          const rel = relative(TUI_DIR, file);
          violations.push(rel);
          break;
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("ArkClientProvider accepts app prop for local mode", () => {
    const content = readFileSync(resolve(TUI_DIR, "context/ArkClientProvider.tsx"), "utf-8");
    expect(content).toContain("app?: AppContext");
    // Verify no getApp import
    expect(content).not.toMatch(/import\s+\{[^}]*\bgetApp\b/);
  });
});

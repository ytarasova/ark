/**
 * Daemon-client boundary test.
 *
 * Ensures no TUI source file (excluding tests and the legacy AppProvider)
 * imports core internals directly. All data access must go through ArkClient RPC.
 *
 * Embedded mode (ARK_TUI_EMBEDDED=1) uses dynamic imports for ArkServer and
 * registerAllHandlers, so static analysis should NOT find these imports.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve, relative } from "path";

const TUI_DIR = resolve(import.meta.dir, "..");

function globTuiSources(): string[] {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const files: string[] = [];
  for (const path of glob.scanSync({ cwd: TUI_DIR, absolute: true })) {
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
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        if (/import\s+\{[^}]*\bgetApp\b[^}]*\}\s+from\s+["'].*core\/app/.test(line)) {
          violations.push(relative(TUI_DIR, file));
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
        if (/\bgetApp\s*\(/.test(trimmed)) {
          violations.push(relative(TUI_DIR, file));
          break;
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no TUI source file statically imports AppContext constructor", () => {
    const violations: string[] = [];
    for (const file of globTuiSources()) {
      const rel = relative(TUI_DIR, file);
      // index.tsx uses dynamic import() for embedded mode -- that's fine
      if (rel === "index.tsx") continue;
      const content = readFileSync(file, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        // Match static import (not type import) of AppContext from core
        if (/^import\s+\{[^}]*\bAppContext\b/.test(trimmed) && !trimmed.includes("import type")) {
          violations.push(rel);
          break;
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no TUI source file statically imports ArkServer or registerAllHandlers", () => {
    const violations: string[] = [];
    for (const file of globTuiSources()) {
      const content = readFileSync(file, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        // Skip dynamic imports (await import(...))
        if (trimmed.includes("await import(")) continue;
        if (/^import\s+.*\b(ArkServer|registerAllHandlers)\b/.test(trimmed)) {
          violations.push(relative(TUI_DIR, file));
          break;
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("no TUI source file statically imports from ../core/ except type-only or index.tsx", () => {
    const violations: string[] = [];
    for (const file of globTuiSources()) {
      const rel = relative(TUI_DIR, file);
      // index.tsx is allowed to dynamically import core for embedded mode
      if (rel === "index.tsx") continue;
      const content = readFileSync(file, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        // Allow: import type { ... } from "../core/..."
        // Allow: import { ... } from "../core/index.js" (re-exported types/theme/state)
        // Deny: import { AppContext } from "../core/app.js" (non-type, non-index)
        if (/^import\s+\{/.test(trimmed) && !trimmed.includes("import type") && /from\s+["']\.\.\/core\/(?!index\.|theme\.|state\/)/.test(trimmed)) {
          violations.push(`${rel}: ${trimmed}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("ArkClientProvider uses dynamic import for server modules in embedded mode", () => {
    const content = readFileSync(resolve(TUI_DIR, "context/ArkClientProvider.tsx"), "utf-8");
    // Should have dynamic import (not static) for ArkServer
    expect(content).toContain('await import("../../server/index.js")');
    // Should NOT have static import of ArkServer
    expect(content).not.toMatch(/^import\s+\{[^}]*ArkServer/m);
    // Should NOT statically import AppContext
    expect(content).not.toMatch(/^import\s+\{[^}]*AppContext/m);
  });
});

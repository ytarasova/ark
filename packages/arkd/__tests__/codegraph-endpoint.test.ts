/**
 * Test the arkd /codegraph/index endpoint.
 *
 * Creates a small temp repo, runs the real codegraph binary (from node_modules/.bin),
 * and verifies the endpoint returns nodes/edges.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { startArkd } from "../server.js";
import { allocatePort } from "../../core/config/port-allocator.js";

let TEST_PORT: number;
let BASE: string;
let server: { stop(): void };
let repoDir: string;

beforeAll(async () => {
  TEST_PORT = await allocatePort();
  BASE = `http://localhost:${TEST_PORT}`;
  repoDir = join(tmpdir(), `arkd-cg-test-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });

  // Create a minimal TS file for codegraph to parse
  writeFileSync(
    join(repoDir, "index.ts"),
    `
export function hello(name: string): string {
  return "hello " + name;
}

export class Greeter {
  greet(name: string): string {
    return hello(name);
  }
}
`,
  );

  server = startArkd(TEST_PORT, { quiet: true });
});

afterAll(() => {
  server.stop();
  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {
    /* cleanup */
  }
});

describe("POST /codegraph/index", () => {
  it("returns nodes and edges for a small repo", async () => {
    // Skip if codegraph binary isn't available
    const cgBin = join(process.cwd(), "node_modules", ".bin", "codegraph");
    if (!existsSync(cgBin)) {
      console.log("  skipped: codegraph binary not found");
      return;
    }

    // Temporarily prepend node_modules/.bin to PATH so the spawn finds codegraph
    const origPath = process.env.PATH;
    process.env.PATH = `${join(process.cwd(), "node_modules", ".bin")}:${origPath}`;

    try {
      const resp = await fetch(`${BASE}/codegraph/index`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoPath: repoDir, incremental: false }),
      });

      const data = (await resp.json()) as any;

      expect(data.ok).toBe(true);
      expect(Array.isArray(data.nodes)).toBe(true);
      expect(Array.isArray(data.edges)).toBe(true);
      expect(data.files).toBeGreaterThanOrEqual(1);
      expect(data.symbols).toBeGreaterThanOrEqual(2); // hello function + Greeter class

      // Verify our specific symbols were extracted
      const names = data.nodes.map((n: any) => n.name);
      expect(names).toContain("hello");
      expect(names).toContain("Greeter");
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("returns 500 when repoPath is invalid", async () => {
    const resp = await fetch(`${BASE}/codegraph/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoPath: "/nonexistent/path/xyz" }),
    });

    const data = (await resp.json()) as any;
    // Either codegraph fails or DB read fails -- both return ok: false
    expect(data.ok).toBe(false);
    expect(data.error).toBeDefined();
  });
});

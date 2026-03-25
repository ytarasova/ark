/**
 * End-to-end CLI tests - exercises the ark CLI via subprocess invocations.
 *
 * Runs actual CLI commands and validates stdout output and side effects.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { join } from "path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(ROOT, "packages", "cli", "index.ts");

function ark(...args: string[]): string {
  return execFileSync("bun", ["run", CLI, ...args], {
    encoding: "utf-8",
    cwd: ROOT,
    timeout: 15_000,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", ARK_TEST_DIR: process.env.ARK_TEST_DIR ?? "" },
  });
}

function arkSafe(...args: string[]): string {
  try {
    return ark(...args);
  } catch (e: any) {
    return e.stdout ?? e.stderr ?? e.message ?? "";
  }
}

// Track resources for cleanup
const testComputes: string[] = [];
const testSessionIds: string[] = [];

afterEach(() => {
  // Clean up computes
  for (const name of testComputes) {
    try { ark("compute", "delete", name); } catch { /* already gone */ }
  }
  testComputes.length = 0;

  // Clean up sessions
  for (const id of testSessionIds) {
    try { ark("session", "delete", id); } catch { /* already gone */ }
  }
  testSessionIds.length = 0;
});

// ── Version ─────────────────────────────────────────────────────────────────

describe("CLI: version", () => {
  it("ark --version returns version string", () => {
    const out = ark("--version");
    expect(out.trim()).toBe("0.1.0");
  });
});

// ── Compute commands ───────────────────────────────────────────────────────────

describe("CLI: compute lifecycle", () => {
  it("creates a compute with --provider ec2", () => {
    const name = `test-e2e-compute-${Date.now()}`;
    testComputes.push(name);

    const out = ark("compute", "create", name, "--provider", "ec2");
    expect(out).toContain(`Compute '${name}' created`);
    expect(out).toContain("Provider: ec2");
  });

  it("lists computes and shows the created compute", () => {
    const name = `test-e2e-list-${Date.now()}`;
    testComputes.push(name);
    ark("compute", "create", name, "--provider", "ec2");

    const out = ark("compute", "list");
    expect(out).toContain(name);
    expect(out).toContain("ec2");
  });

  it("shows compute status as JSON", () => {
    // Use ec2 provider so compute starts as "stopped" - avoids the async
    // metrics fetch that makes `compute status` hang for local/running computes
    const name = `test-e2e-status-${Date.now()}`;
    testComputes.push(name);
    ark("compute", "create", name, "--provider", "ec2");

    const out = ark("compute", "status", name);
    // compute status outputs JSON for the compute object
    expect(out).toContain(`"name": "${name}"`);
    expect(out).toContain(`"provider": "ec2"`);
    expect(out).toContain(`"status": "stopped"`);
  });

  it("updates compute config with --set", () => {
    const name = `test-e2e-update-${Date.now()}`;
    testComputes.push(name);
    ark("compute", "create", name, "--provider", "ec2");

    const out = ark("compute", "update", name, "--set", "foo=bar");
    expect(out).toContain(`Compute '${name}' updated`);
    expect(out).toContain('"foo": "bar"');
  });

  it("rejects deleting a running compute", () => {
    // The auto-created "local" compute is always running, so delete should fail
    const delOut = arkSafe("compute", "delete", "local");
    expect(delOut).toContain("running");
  });

  it("deletes a stopped compute", () => {
    // EC2 computes start as "stopped" which allows deletion
    const name = `test-e2e-del2-${Date.now()}`;
    ark("compute", "create", name, "--provider", "ec2");

    const out = ark("compute", "delete", name);
    expect(out).toContain(`Compute '${name}' deleted`);
  });
});

// ── Session commands ────────────────────────────────────────────────────────

describe("CLI: session lifecycle", () => {
  it("creates a session with --repo and --summary", () => {
    const out = ark("session", "start", "--repo", ".", "--summary", "test-e2e-session", "--flow", "bare");
    expect(out).toContain("Session");
    expect(out).toContain("created");
    expect(out).toContain("test-e2e-session");

    // Extract session ID from output
    const match = out.match(/Session (s-[0-9a-f]+) created/);
    expect(match).not.toBeNull();
    if (match) testSessionIds.push(match[1]);
  });

  it("lists sessions", () => {
    const createOut = ark("session", "start", "--repo", ".", "--summary", "list-test", "--flow", "bare");
    const match = createOut.match(/Session (s-[0-9a-f]+) created/);
    if (match) testSessionIds.push(match[1]);

    const out = ark("session", "list");
    // Should contain at least the session we just created
    expect(out).toContain("list-test");
  });

  it("shows session details", () => {
    const createOut = ark("session", "start", "--repo", ".", "--summary", "show-test", "--flow", "bare");
    const match = createOut.match(/Session (s-[0-9a-f]+) created/);
    expect(match).not.toBeNull();
    const id = match![1];
    testSessionIds.push(id);

    const out = ark("session", "show", id);
    expect(out).toContain(id);
    expect(out).toContain("show-test");
    expect(out).toContain("Flow:");
  });

  it("deletes a session", async () => {
    const createOut = ark("session", "start", "--repo", ".", "--summary", "delete-test", "--flow", "bare");
    const match = createOut.match(/Session (s-[0-9a-f]+) created/);
    expect(match).not.toBeNull();
    const id = match![1];

    const out = ark("session", "delete", id);
    expect(out).toContain(`Deleted ${id}`);

    // Verify it's gone
    const showOut = arkSafe("session", "show", id);
    expect(showOut).toContain("not found");
  }, 30_000);
});

// ── Agent & Flow commands ───────────────────────────────────────────────

describe("CLI: agent list", () => {
  it("lists available agents", () => {
    const out = ark("agent", "list");
    // Should list at least the builtin agents
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("CLI: flow list", () => {
  it("lists available flows", () => {
    const out = ark("flow", "list");
    // Should list at least the builtin flows
    expect(out.length).toBeGreaterThan(0);
  });
});

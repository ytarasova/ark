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
    env: { ...process.env, NO_COLOR: "1" },
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
const testHosts: string[] = [];
const testSessionIds: string[] = [];

afterEach(() => {
  // Clean up hosts
  for (const name of testHosts) {
    try { ark("host", "delete", name); } catch { /* already gone */ }
  }
  testHosts.length = 0;

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

// ── Host commands ───────────────────────────────────────────────────────────

describe("CLI: host lifecycle", () => {
  it("creates a host with --provider local", () => {
    const name = `test-e2e-host-${Date.now()}`;
    testHosts.push(name);

    const out = ark("host", "create", name, "--provider", "local");
    expect(out).toContain(`Host '${name}' created`);
    expect(out).toContain("Provider: local");
  });

  it("lists hosts and shows the created host", () => {
    const name = `test-e2e-list-${Date.now()}`;
    testHosts.push(name);
    ark("host", "create", name, "--provider", "local");

    const out = ark("host", "list");
    expect(out).toContain(name);
    expect(out).toContain("local");
  });

  it("shows host status as JSON", () => {
    // Use ec2 provider so host starts as "stopped" - avoids the async
    // metrics fetch that makes `host status` hang for local/running hosts
    const name = `test-e2e-status-${Date.now()}`;
    testHosts.push(name);
    ark("host", "create", name, "--provider", "ec2");

    const out = ark("host", "status", name);
    // host status outputs JSON for the host object
    expect(out).toContain(`"name": "${name}"`);
    expect(out).toContain(`"provider": "ec2"`);
    expect(out).toContain(`"status": "stopped"`);
  });

  it("updates host config with --set", () => {
    const name = `test-e2e-update-${Date.now()}`;
    testHosts.push(name);
    ark("host", "create", name, "--provider", "local");

    const out = ark("host", "update", name, "--set", "foo=bar");
    expect(out).toContain(`Host '${name}' updated`);
    expect(out).toContain('"foo": "bar"');
  });

  it("rejects deleting a running host", () => {
    const name = `test-e2e-del-${Date.now()}`;
    testHosts.push(name);
    ark("host", "create", name, "--provider", "local");

    // Local hosts start as "running" so delete should fail
    const delOut = arkSafe("host", "delete", name);
    expect(delOut).toContain("running");
  });

  it("deletes a stopped host", () => {
    // EC2 hosts start as "stopped" which allows deletion
    const name = `test-e2e-del2-${Date.now()}`;
    ark("host", "create", name, "--provider", "ec2");

    const out = ark("host", "delete", name);
    expect(out).toContain(`Host '${name}' deleted`);
  });
});

// ── Session commands ────────────────────────────────────────────────────────

describe("CLI: session lifecycle", () => {
  it("creates a session with --repo and --summary", () => {
    const out = ark("session", "start", "--repo", ".", "--summary", "test-e2e-session", "--pipeline", "bare");
    expect(out).toContain("Session");
    expect(out).toContain("created");
    expect(out).toContain("test-e2e-session");

    // Extract session ID from output
    const match = out.match(/Session (s-[0-9a-f]+) created/);
    expect(match).not.toBeNull();
    if (match) testSessionIds.push(match[1]);
  });

  it("lists sessions", () => {
    const createOut = ark("session", "start", "--repo", ".", "--summary", "list-test", "--pipeline", "bare");
    const match = createOut.match(/Session (s-[0-9a-f]+) created/);
    if (match) testSessionIds.push(match[1]);

    const out = ark("session", "list");
    // Should contain at least the session we just created
    expect(out).toContain("list-test");
  });

  it("shows session details", () => {
    const createOut = ark("session", "start", "--repo", ".", "--summary", "show-test", "--pipeline", "bare");
    const match = createOut.match(/Session (s-[0-9a-f]+) created/);
    expect(match).not.toBeNull();
    const id = match![1];
    testSessionIds.push(id);

    const out = ark("session", "show", id);
    expect(out).toContain(id);
    expect(out).toContain("show-test");
    expect(out).toContain("Pipeline:");
  });

  it("deletes a session", () => {
    const createOut = ark("session", "start", "--repo", ".", "--summary", "delete-test", "--pipeline", "bare");
    const match = createOut.match(/Session (s-[0-9a-f]+) created/);
    expect(match).not.toBeNull();
    const id = match![1];

    const out = ark("session", "delete", id);
    expect(out).toContain(`Deleted ${id}`);

    // Verify it's gone
    const showOut = arkSafe("session", "show", id);
    expect(showOut).toContain("not found");
  });
});

// ── Agent & Pipeline commands ───────────────────────────────────────────────

describe("CLI: agent list", () => {
  it("lists available agents", () => {
    const out = ark("agent", "list");
    // Should list at least the builtin agents
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("CLI: pipeline list", () => {
  it("lists available pipelines", () => {
    const out = ark("pipeline", "list");
    // Should list at least the builtin pipelines
    expect(out.length).toBeGreaterThan(0);
  });
});

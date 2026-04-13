/**
 * Tests for worktree untracked file setup (.ark.yaml worktree.copy + worktree.setup).
 *
 * Git worktrees don't include untracked files (.env, .envrc, config/local.yaml),
 * so agents dispatched into worktrees lose local config. The worktree.copy list
 * and worktree.setup script in .ark.yaml address this by copying specified files
 * and running a setup command after worktree creation.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "fs";
import { join, resolve } from "path";

import { AppContext, setApp, clearApp } from "../app.js";
import { setupSessionWorktree } from "../services/session-orchestration.js";
import { getProvider } from "../../compute/index.js";

function canonical(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

let app: AppContext;
let originalCwd: string;
let repoDir: string;

beforeEach(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();

  // Set up a real git repo to serve as the "live" checkout.
  repoDir = join(app.config.arkDir, "fake-live-repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", repoDir], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Test"], { stdio: "pipe" });

  originalCwd = process.cwd();
  process.chdir(repoDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await app?.shutdown();
  clearApp();
});

/** Helper: write .ark.yaml, commit it so it exists in the worktree. */
function writeArkYaml(content: string) {
  writeFileSync(join(repoDir, ".ark.yaml"), content);
  execFileSync("git", ["-C", repoDir, "add", ".ark.yaml"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "commit", "-m", "add .ark.yaml"], { stdio: "pipe" });
}

/** Helper: create an untracked file in the repo (NOT committed). */
function writeUntracked(relPath: string, content: string) {
  const abs = join(repoDir, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

/** Helper: create a session and run setupSessionWorktree. */
async function setupSession(summary: string) {
  const session = app.sessions.create({ summary, repo: repoDir, workdir: repoDir });
  const provider = getProvider("local") ?? undefined;
  const effectiveWorkdir = await setupSessionWorktree(app, session, null, provider);
  return { session, effectiveWorkdir };
}

describe("worktree untracked file setup", () => {
  it("copies listed files from repo to worktree", async () => {
    writeArkYaml(`
worktree:
  copy:
    - .env
    - config/local.yaml
`);
    writeUntracked(".env", "SECRET=abc123");
    writeUntracked("config/local.yaml", "db: localhost:5432");

    const { effectiveWorkdir } = await setupSession("copy files test");

    // Both files must exist in worktree with correct content
    expect(readFileSync(join(effectiveWorkdir, ".env"), "utf-8")).toBe("SECRET=abc123");
    expect(readFileSync(join(effectiveWorkdir, "config/local.yaml"), "utf-8")).toBe("db: localhost:5432");
  });

  it("runs setup script after copy", async () => {
    writeArkYaml(`
worktree:
  setup: "touch .setup-ran"
`);

    const { effectiveWorkdir } = await setupSession("setup script test");

    expect(existsSync(join(effectiveWorkdir, ".setup-ran"))).toBe(true);
  });

  it("surfaces file copy errors as events + messages (not thrown)", async () => {
    writeArkYaml(`
worktree:
  copy:
    - nonexistent.env
`);

    // Must NOT throw
    const { session } = await setupSession("missing file test");

    // Check for worktree_setup_error event
    const events = app.events.list(session.id);
    const errorEvents = events.filter(e => e.type === "worktree_setup_error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    const data = typeof errorEvents[0].data === "string" ? JSON.parse(errorEvents[0].data) : errorEvents[0].data;
    expect(data.file).toBe("nonexistent.env");

    // Check for system error message
    const messages = app.messages.list(session.id);
    const errorMsgs = messages.filter(m => m.role === "system" && m.type === "error");
    expect(errorMsgs.length).toBeGreaterThanOrEqual(1);
    expect(errorMsgs[0].content).toContain("nonexistent.env");
  });

  it("surfaces setup script errors as events + messages", async () => {
    writeArkYaml(`
worktree:
  setup: "exit 1"
`);

    // Must NOT throw
    const { session } = await setupSession("failing script test");

    const events = app.events.list(session.id);
    const errorEvents = events.filter(e => e.type === "worktree_setup_error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    const data = typeof errorEvents[0].data === "string" ? JSON.parse(errorEvents[0].data) : errorEvents[0].data;
    expect(data.script).toBe("exit 1");

    const messages = app.messages.list(session.id);
    const errorMsgs = messages.filter(m => m.role === "system" && m.type === "error");
    expect(errorMsgs.length).toBeGreaterThanOrEqual(1);
    expect(errorMsgs[0].content).toContain("exit 1");
  });

  it("rejects path traversal attempts", async () => {
    writeArkYaml(`
worktree:
  copy:
    - "../../etc/passwd"
`);

    const { session, effectiveWorkdir } = await setupSession("traversal test");

    // File must NOT be copied
    expect(existsSync(join(effectiveWorkdir, "../../etc/passwd"))).toBe(false);

    // Error event must mention traversal
    const events = app.events.list(session.id);
    const errorEvents = events.filter(e => e.type === "worktree_setup_error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    const data = typeof errorEvents[0].data === "string" ? JSON.parse(errorEvents[0].data) : errorEvents[0].data;
    expect(data.error).toContain("path traversal");
  });

  it("rejects absolute path attempts", async () => {
    writeArkYaml(`
worktree:
  copy:
    - "/etc/passwd"
`);

    const { session } = await setupSession("absolute path test");

    const events = app.events.list(session.id);
    const errorEvents = events.filter(e => e.type === "worktree_setup_error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    const data = typeof errorEvents[0].data === "string" ? JSON.parse(errorEvents[0].data) : errorEvents[0].data;
    expect(data.error).toContain("path traversal");
  });

  it("no-op when worktree config is absent", async () => {
    writeArkYaml(`
flow: default
`);

    // Should succeed with no errors
    const { session } = await setupSession("no worktree config test");

    const events = app.events.list(session.id);
    const errorEvents = events.filter(e => e.type === "worktree_setup_error");
    expect(errorEvents.length).toBe(0);
  });

  it("copies files and then runs setup script", async () => {
    writeArkYaml(`
worktree:
  copy:
    - .env
  setup: "cat .env > .env.verified"
`);
    writeUntracked(".env", "TOKEN=xyz");

    const { effectiveWorkdir } = await setupSession("copy then setup test");

    // .env was copied, then setup script read it and wrote .env.verified
    expect(readFileSync(join(effectiveWorkdir, ".env"), "utf-8")).toBe("TOKEN=xyz");
    expect(readFileSync(join(effectiveWorkdir, ".env.verified"), "utf-8")).toBe("TOKEN=xyz");
  });
});

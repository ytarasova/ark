/**
 * E2E tests for repo-scoped config (.ark.yaml).
 *
 * Verifies that startSession reads .ark.yaml from the workdir and
 * merges config defaults into the session, and that explicit options
 * override the config.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AppContext, setApp, clearApp } from "../app.js";
import { startSession } from "../services/session-orchestration.js";

let app: AppContext;
beforeAll(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

const sessionIds: string[] = [];
afterEach(() => {
  for (const id of sessionIds) {
    try { app.sessions.delete(id); } catch {}
  }
  sessionIds.length = 0;
});

describe("repo-scoped config E2E", () => {
  it("startSession picks up flow and group from .ark.yaml", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "ark-e2e-repo-"));
    writeFileSync(join(repoDir, ".ark.yaml"), "flow: bare\ngroup: team-alpha\n");

    const session = startSession(app, {
      summary: "e2e-repo-config-basic",
      workdir: repoDir,
    });
    sessionIds.push(session.id);

    expect(session.flow).toBe("bare");
    expect(session.group_name).toBe("team-alpha");
  });

  it("explicit options override .ark.yaml defaults", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "ark-e2e-repo-"));
    writeFileSync(join(repoDir, ".ark.yaml"), "flow: bare\ngroup: config-group\ncompute: config-compute\n");

    const session = startSession(app, {
      summary: "e2e-repo-config-override",
      workdir: repoDir,
      flow: "bare",
      group_name: "explicit-group",
    });
    sessionIds.push(session.id);

    expect(session.flow).toBe("bare");
    expect(session.group_name).toBe("explicit-group");
  });

  it("no config file means defaults are used", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "ark-e2e-repo-empty-"));

    const session = startSession(app, {
      summary: "e2e-repo-config-none",
      workdir: repoDir,
    });
    sessionIds.push(session.id);

    // Default flow is "default" when nothing is specified
    expect(session.flow).toBe("default");
    expect(session.group_name).toBeNull();
    expect(session.compute_name).toBeNull();
  });

  it("falls back to repo path when workdir is not set", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "ark-e2e-repo-fallback-"));
    writeFileSync(join(repoDir, ".ark.yaml"), "group: from-repo\n");

    const session = startSession(app, {
      summary: "e2e-repo-config-fallback",
      repo: repoDir,
    });
    sessionIds.push(session.id);

    expect(session.group_name).toBe("from-repo");
  });

  it("handles .ark.yml variant", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "ark-e2e-repo-yml-"));
    writeFileSync(join(repoDir, ".ark.yml"), "flow: bare\n");

    const session = startSession(app, {
      summary: "e2e-repo-config-yml",
      workdir: repoDir,
    });
    sessionIds.push(session.id);

    expect(session.flow).toBe("bare");
  });

  it("malformed YAML does not break session creation", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "ark-e2e-repo-bad-"));
    writeFileSync(join(repoDir, ".ark.yaml"), "{{{{invalid");

    const session = startSession(app, {
      summary: "e2e-repo-config-bad-yaml",
      workdir: repoDir,
    });
    sessionIds.push(session.id);

    // Should still create with defaults
    expect(session.id).toBeTruthy();
    expect(session.flow).toBe("default");
  });
});

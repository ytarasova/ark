import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../../../app.js";
import { syncBurn } from "../sync.js";
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { join, resolve } from "path";

let app: AppContext;

beforeAll(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

describe("syncBurn", () => {
  it("syncs a session with a transcript and populates burn_turns", () => {
    // Create a session with a workdir that matches a transcript location.
    // We'll set up the transcript in the Claude projects dir structure that
    // the ClaudeTranscriptParser expects.
    const workdir = join(app.arkDir, "test-project");
    mkdirSync(workdir, { recursive: true });

    const session = app.sessions.create({
      summary: "Burn sync test session",
      config: { runtime: "claude" },
    });
    app.sessions.update(session.id, { workdir });

    // The ClaudeTranscriptParser expects transcripts at:
    //   <projectsDir>/<slug>/<filename>.jsonl
    // where slug is resolve(workdir) with / and . replaced by -
    // The parser in AppContext uses homedir()/.claude/projects as projectsDir,
    // but for the test we need to work with whatever the app's transcript parser uses.
    // Since AppContext.forTest() creates a ClaudeTranscriptParser with default projectsDir,
    // we'll create the transcript in the expected location.
    const slug = resolve(workdir).replace(/\//g, "-").replace(/\./g, "-");
    const projectsDir = join(
      require("os").homedir(),
      ".claude",
      "projects",
    );
    const slugDir = join(projectsDir, slug);
    mkdirSync(slugDir, { recursive: true });

    // Copy the fixture JSONL into the slug directory
    const fixturePath = join(
      import.meta.dir,
      "fixtures",
      "claude-session.jsonl",
    );
    const transcriptPath = join(slugDir, "test-sync.jsonl");
    copyFileSync(fixturePath, transcriptPath);

    // First sync: should sync
    const result1 = syncBurn(app, { sessionIds: [session.id] });
    expect(result1.synced).toBeGreaterThanOrEqual(1);

    // Verify turns were populated
    const turns = app.burn.getTurns(session.id);
    expect(turns.length).toBeGreaterThan(0);
    expect(turns[0].session_id).toBe(session.id);
    expect(turns[0].category).toBeTruthy();

    // Second sync (no force): should skip because mtime hasn't changed
    const result2 = syncBurn(app, { sessionIds: [session.id] });
    expect(result2.skipped).toBeGreaterThanOrEqual(1);

    // Force sync: should re-sync
    const result3 = syncBurn(app, { sessionIds: [session.id], force: true });
    expect(result3.synced).toBeGreaterThanOrEqual(1);

    // Clean up the transcript we created in the real Claude projects dir
    try {
      const { rmSync } = require("fs");
      rmSync(slugDir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  });
});

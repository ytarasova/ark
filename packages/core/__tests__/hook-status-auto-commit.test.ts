/**
 * Auto-commit rescue: when an agent exits without committing but the
 * worktree has uncommitted changes, applyHookStatus should auto-commit
 * them so the flow can advance instead of dropping the work on the
 * floor with "Agent exited without committing any changes".
 *
 * This typically fires when the dispatch prompt gates commits behind
 * a check the agent decided didn't pass (e.g. lint failed) and the
 * model interprets that as "stop without committing".
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AppContext } from "../app.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ark-auto-commit-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["checkout", "-b", "test-branch"], { cwd: dir });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "--allow-empty", "-m", "initial"],
    { cwd: dir },
  );
  return dir;
}

describe("hook-status auto-commit rescue", () => {
  it("auto-commits uncommitted changes on SessionEnd and advances the stage", async () => {
    const gitDir = createTempGitRepo();
    const startSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir, encoding: "utf-8" }).trim();

    // Agent edited a file but never committed.
    writeFileSync(join(gitDir, "feature.ts"), "export const x = 1;\n");

    const session = await app.sessions.create({ summary: "uncommitted rescue", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });
    await app.sessions.mergeConfig(session.id, { stage_start_sha: startSha });

    const fresh = await app.sessions.get(session.id);
    const result = await app.sessionHooks.applyHookStatus(fresh!, "SessionEnd", {});

    expect(result.shouldAdvance).toBe(true);
    expect(result.shouldAutoDispatch).toBe(true);

    const auto = result.events?.find((e) => e.type === "auto_commit");
    expect(auto).toBeTruthy();
    expect(auto?.opts?.data?.files_changed).toBe(1);
    expect(typeof auto?.opts?.data?.head_sha).toBe("string");

    // HEAD should now differ from stage_start_sha -- the rescue committed.
    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir, encoding: "utf-8" }).trim();
    expect(headAfter).not.toBe(startSha);
  });

  it("still fails when the worktree is genuinely clean", async () => {
    const gitDir = createTempGitRepo();
    const startSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitDir, encoding: "utf-8" }).trim();

    const session = await app.sessions.create({ summary: "no work done", flow: "quick" });
    await app.sessions.update(session.id, {
      session_id: `ark-s-${session.id}`,
      status: "running",
      stage: "implement",
      workdir: gitDir,
      branch: "test-branch",
    });
    await app.sessions.mergeConfig(session.id, { stage_start_sha: startSha });

    const fresh = await app.sessions.get(session.id);
    const result = await app.sessionHooks.applyHookStatus(fresh!, "SessionEnd", {});

    expect(result.shouldAdvance).toBeFalsy();
    expect(result.updates?.error).toContain("without committing");
    expect(result.events?.some((e) => e.type === "auto_commit")).toBe(false);
  });
});

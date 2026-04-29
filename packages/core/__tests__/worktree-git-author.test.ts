/**
 * Per-worktree git author identity.
 *
 * Real incident (PAI-31995 dispatch on the staging box): the host's
 * `~/.gitconfig` had `user.email=ark-test@example.com` from a manual
 * setup. The agent's commits inherited that, and Bitbucket's
 * BB Violator hook auto-rewrote the commit (changing the SHA and
 * appending a marker file) because the email isn't a valid Paytm
 * address.
 *
 * The fix sets `user.name` / `user.email` on the worktree's local
 * git config the moment Ark creates the worktree, so commits don't
 * fall through to the host's global config. Defaults are
 * "Ark Agent" / "agent@ark.local"; both are overridable via
 * `app.config.git.author{Name,Email}`, `~/.ark/config.yaml`, or
 * `ARK_GIT_AUTHOR_NAME` / `ARK_GIT_AUTHOR_EMAIL`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdirSync } from "fs";
import { join } from "path";

import { AppContext } from "../app.js";
import { setupSessionWorktree } from "../services/worktree/index.js";
import { getProvider } from "../../compute/index.js";

let app: AppContext;
let originalCwd: string;
let repoDir: string;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();

  repoDir = join(app.config.arkDir, "fake-live-repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", repoDir], { stdio: "pipe" });
  // Set a host-level identity that we explicitly do NOT want the agent
  // to inherit on its commits.
  execFileSync("git", ["-C", repoDir, "config", "user.email", "host-config@example.com"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Host User"], { stdio: "pipe" });
  execFileSync("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "init"], { stdio: "pipe" });

  originalCwd = process.cwd();
  process.chdir(repoDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await app?.shutdown();
});

function readWorktreeIdentity(wt: string): { name: string; email: string } {
  const name = execFileSync("git", ["-C", wt, "config", "user.name"], { encoding: "utf-8" }).trim();
  const email = execFileSync("git", ["-C", wt, "config", "user.email"], { encoding: "utf-8" }).trim();
  return { name, email };
}

describe("setupSessionWorktree -- git author identity", () => {
  it("pins user.name / user.email on the worktree's local git config", async () => {
    const session = await app.sessions.create({ summary: "git-author test", repo: "." });
    const provider = getProvider("local") ?? undefined;
    const wt = await setupSessionWorktree(app, session, null, provider);

    const { name, email } = readWorktreeIdentity(wt);
    expect(name).toBe(app.config.git?.authorName ?? "Ark Agent");
    expect(email).toBe(app.config.git?.authorEmail ?? "agent@ark.local");
  });

  it("does NOT inherit the host's global git identity on agent commits", async () => {
    const session = await app.sessions.create({ summary: "git-author isolation", repo: "." });
    const provider = getProvider("local") ?? undefined;
    const wt = await setupSessionWorktree(app, session, null, provider);

    const { email } = readWorktreeIdentity(wt);
    expect(email).not.toBe("host-config@example.com");
  });

  it("honors app.config.git override when present", async () => {
    // Mutate the resolved config directly -- this is what env-source /
    // YAML overlay will produce in real deployments.
    (app.config as Record<string, unknown>).git = {
      authorName: "Custom Bot",
      authorEmail: "bot@example.org",
    };

    const session = await app.sessions.create({ summary: "git-author override", repo: "." });
    const provider = getProvider("local") ?? undefined;
    const wt = await setupSessionWorktree(app, session, null, provider);

    expect(readWorktreeIdentity(wt)).toEqual({ name: "Custom Bot", email: "bot@example.org" });
  });
});

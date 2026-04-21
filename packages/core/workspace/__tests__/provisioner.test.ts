/**
 * Workspace provisioner tests (Wave 2b-1, LOCAL compute).
 *
 * Uses a tmpdir + `git init`-ed local repos as clone sources so the test does
 * not touch the network. The clone destination is the workspace workdir
 * provisioned beneath the AppContext's arkDir (each `forTestAsync()` gets a
 * fresh dir, so parallel runs don't collide).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { execFile } from "child_process";

import { AppContext } from "../../app.js";
import { DEFAULT_TENANT_ID } from "../../code-intel/store.js";
import {
  ensureRepoCloned,
  listWorkspaceRepoSlugs,
  provisionWorkspaceWorkdir,
  readSessionManifest,
  sessionBranchName,
  workspaceWorkdir,
} from "../provisioner.js";
import { MANIFEST_FILENAME, manifestPath, readManifest } from "../manifest.js";

const execFileAsync = promisify(execFile);

let app: AppContext;
let cloneSourceA: string;
let cloneSourceB: string;
let scratchDir: string;

async function gitInit(dir: string, fileContents: Record<string, string> = { "README.md": "hello\n" }) {
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  for (const [name, content] of Object.entries(fileContents)) {
    writeFileSync(join(dir, name), content, "utf-8");
  }
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
}

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  // `ensureRepoCloned` falls back to `session.tenant_id ?? "default"` when the
  // session has no tenant set. To exercise the happy path here we pin the
  // session repository's tenantId to the code-intel DEFAULT_TENANT_ID UUID
  // (the value that `createWorkspace` + `createRepo` use). This is also what
  // happens at runtime once auth is wired in; a legacy session with
  // tenant_id=null exercises a separate branch not under test here.
  app.sessions.setTenant(DEFAULT_TENANT_ID);

  scratchDir = mkdtempSync(join(tmpdir(), "ark-prov-src-"));
  cloneSourceA = join(scratchDir, "src-a");
  cloneSourceB = join(scratchDir, "src-b");
  for (const d of [cloneSourceA, cloneSourceB]) {
    mkdirSync(d, { recursive: true });
    await gitInit(d, { "README.md": `repo at ${d}\n` });
  }
});

afterAll(async () => {
  await app?.shutdown();
  rmSync(scratchDir, { recursive: true, force: true });
});

async function makeWorkspaceWithRepos(slugSuffix: string): Promise<{
  workspaceId: string;
  repoIdA: string;
  repoIdB: string;
}> {
  const ws = await app.codeIntel.createWorkspace({
    tenant_id: DEFAULT_TENANT_ID,
    slug: `ws-${slugSuffix}`,
    name: `Workspace ${slugSuffix}`,
  });
  // repo_url has UNIQUE(tenant_id, repo_url); include the suffix to avoid
  // collisions with repos created by sibling tests in this file.
  const a = await app.codeIntel.createRepo({
    tenant_id: DEFAULT_TENANT_ID,
    repo_url: `file://${cloneSourceA}#${slugSuffix}`,
    name: `payments-${slugSuffix}`,
    local_path: cloneSourceA,
  });
  const b = await app.codeIntel.createRepo({
    tenant_id: DEFAULT_TENANT_ID,
    repo_url: `file://${cloneSourceB}#${slugSuffix}`,
    name: `auth-${slugSuffix}`,
    local_path: cloneSourceB,
  });
  await app.codeIntel.addRepoToWorkspace(a.id, ws.id);
  await app.codeIntel.addRepoToWorkspace(b.id, ws.id);
  return { workspaceId: ws.id, repoIdA: a.id, repoIdB: b.id };
}

describe("workspace provisioner", async () => {
  it("provisionWorkspaceWorkdir creates the dir + writes .ark-workspace.yaml", async () => {
    const { workspaceId } = await makeWorkspaceWithRepos("p1");
    const ws = (await app.codeIntel.getWorkspace(workspaceId))!;
    const session = await app.sessions.create({ summary: "p1-session", workspace_id: workspaceId });

    const wd = await provisionWorkspaceWorkdir(app, session, ws);
    expect(wd).toBe(workspaceWorkdir(app, session.id));
    expect(existsSync(wd)).toBe(true);
    expect(existsSync(join(wd, MANIFEST_FILENAME))).toBe(true);
    expect(manifestPath(wd)).toBe(join(wd, MANIFEST_FILENAME));
  });

  it("manifest lists every workspace repo with cloned=false on first provision", async () => {
    const { workspaceId } = await makeWorkspaceWithRepos("p2");
    const ws = (await app.codeIntel.getWorkspace(workspaceId))!;
    const session = await app.sessions.create({ summary: "p2-session", workspace_id: workspaceId });

    const wd = await provisionWorkspaceWorkdir(app, session, ws, { primaryRepoId: null });
    const manifest = readManifest(wd)!;
    expect(manifest.session_id).toBe(session.id);
    expect(manifest.workspace_id).toBe(workspaceId);
    expect(manifest.primary_repo_id).toBeNull();
    expect(manifest.repos.length).toBe(2);
    for (const r of manifest.repos) {
      expect(r.cloned).toBe(false);
      expect(r.commit).toBeNull();
      expect(r.branch).toBe(sessionBranchName(session.id));
      expect(r.local_path.startsWith(wd)).toBe(true);
    }
    // listWorkspaceRepoSlugs is the executor-facing helper.
    expect(listWorkspaceRepoSlugs(app, session.id).length).toBe(2);
  });

  it("ensureRepoCloned creates the on-disk clone and flips manifest.cloned", async () => {
    const { workspaceId } = await makeWorkspaceWithRepos("p3");
    const ws = (await app.codeIntel.getWorkspace(workspaceId))!;
    const session = await app.sessions.create({ summary: "p3-session", workspace_id: workspaceId });
    const wd = await provisionWorkspaceWorkdir(app, session, ws);

    const before = readManifest(wd)!.repos.find((r) => r.slug.startsWith("payments"))!;
    expect(before.cloned).toBe(false);

    const after = await ensureRepoCloned(app, session.id, before.slug);
    expect(after.cloned).toBe(true);
    expect(after.commit).toMatch(/^[0-9a-f]{7,}/);
    expect(existsSync(join(before.local_path, ".git"))).toBe(true);
    expect(existsSync(join(before.local_path, "README.md"))).toBe(true);

    // Manifest persisted the flipped state.
    const reloaded = readManifest(wd)!;
    const persisted = reloaded.repos.find((r) => r.slug === before.slug)!;
    expect(persisted.cloned).toBe(true);
    expect(persisted.commit).toBe(after.commit);
  });

  it("ensureRepoCloned is idempotent: second call no-ops on already-cloned repos", async () => {
    const { workspaceId } = await makeWorkspaceWithRepos("p4");
    const ws = (await app.codeIntel.getWorkspace(workspaceId))!;
    const session = await app.sessions.create({ summary: "p4-session", workspace_id: workspaceId });
    const wd = await provisionWorkspaceWorkdir(app, session, ws);

    const slug = readManifest(wd)!.repos[0].slug;
    const first = await ensureRepoCloned(app, session.id, slug);
    const firstCommit = first.commit;
    const firstBranch = first.branch;

    // Second call should return early with the same data; the on-disk clone
    // is untouched (we'd error trying to re-create the branch otherwise).
    const second = await ensureRepoCloned(app, session.id, slug);
    expect(second.cloned).toBe(true);
    expect(second.commit).toBe(firstCommit);
    expect(second.branch).toBe(firstBranch);
  });

  it("session branch collision is recoverable: appends a suffix and warns", async () => {
    // For collision to fire, the cloned destination must already have a LOCAL
    // ref at refs/heads/<baseBranch>. `git clone` only carries local heads
    // when the source has the branch checked out as HEAD or when we use
    // `--branch`. Easiest deterministic setup: dedicated clone source whose
    // HEAD is already on the colliding branch name.
    const dedicatedSource = join(scratchDir, "src-collide");
    mkdirSync(dedicatedSource, { recursive: true });
    await gitInit(dedicatedSource, { "README.md": "collide source\n" });

    const ws = await app.codeIntel.createWorkspace({
      tenant_id: DEFAULT_TENANT_ID,
      slug: "ws-p5",
      name: "WS p5",
    });
    const repo = await app.codeIntel.createRepo({
      tenant_id: DEFAULT_TENANT_ID,
      repo_url: `file://${dedicatedSource}#p5`,
      name: "collide-p5",
      local_path: dedicatedSource,
    });
    await app.codeIntel.addRepoToWorkspace(repo.id, ws.id);

    const session = await app.sessions.create({ summary: "p5-session", workspace_id: ws.id });
    const baseBranch = sessionBranchName(session.id);

    // Rename the default HEAD branch in the source to the colliding name so
    // the clone lands with refs/heads/<baseBranch> already present.
    await execFileAsync("git", ["-C", dedicatedSource, "branch", "-M", baseBranch], { encoding: "utf-8" });

    const wd = await provisionWorkspaceWorkdir(app, session, ws);
    const slug = readManifest(wd)!.repos[0].slug;

    const result = await ensureRepoCloned(app, session.id, slug);
    expect(result.cloned).toBe(true);
    expect(result.branch).not.toBe(baseBranch);
    expect(result.branch.startsWith(baseBranch + "-")).toBe(true);
    expect(result.branch.length).toBe(baseBranch.length + 5); // "-XXXX" suffix
  });

  it("ensureRepoCloned errors when the manifest is missing", async () => {
    const session = await app.sessions.create({ summary: "no-manifest-session" });
    (await expect(ensureRepoCloned(app, session.id, "anything"))).rejects.toThrow(/no workspace manifest/);
  });

  it("ensureRepoCloned errors when the slug does not exist in the manifest", async () => {
    const { workspaceId } = await makeWorkspaceWithRepos("p6");
    const ws = (await app.codeIntel.getWorkspace(workspaceId))!;
    const session = await app.sessions.create({ summary: "p6-session", workspace_id: workspaceId });
    await provisionWorkspaceWorkdir(app, session, ws);
    (await expect(ensureRepoCloned(app, session.id, "nope-not-here"))).rejects.toThrow(/no repo with slug/);
  });

  it("readSessionManifest returns null for a session that was never workspace-provisioned", async () => {
    const session = await app.sessions.create({ summary: "legacy-session" });
    expect(readSessionManifest(app, session.id)).toBeNull();
  });

  it("re-running provisionWorkspaceWorkdir preserves cloned=true on already-materialised repos", async () => {
    const { workspaceId } = await makeWorkspaceWithRepos("p7");
    const ws = (await app.codeIntel.getWorkspace(workspaceId))!;
    const session = await app.sessions.create({ summary: "p7-session", workspace_id: workspaceId });
    const wd = await provisionWorkspaceWorkdir(app, session, ws);
    const slug = readManifest(wd)!.repos[0].slug;
    await ensureRepoCloned(app, session.id, slug);

    // Re-provision (idempotent path).
    await provisionWorkspaceWorkdir(app, session, ws);
    const reloaded = readManifest(wd)!;
    const cloned = reloaded.repos.find((r) => r.slug === slug)!;
    expect(cloned.cloned).toBe(true);
    expect(cloned.commit).toMatch(/^[0-9a-f]{7,}/);

    // The companion repo (untouched) is still cloned=false.
    const untouched = reloaded.repos.find((r) => r.slug !== slug)!;
    expect(untouched.cloned).toBe(false);
    expect(untouched.commit).toBeNull();

    // Sanity: the on-disk clone lives where the manifest claims and shows
    // some content from the source.
    const onDisk = readdirSync(cloned.local_path);
    expect(onDisk).toContain("README.md");
  });
});

/**
 * git-contributors extractor -- needs a multi-author commit history.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gitContributorsExtractor } from "../extractors/git-contributors.js";
import { runGit } from "../util/git.js";
import { FilesystemVendorResolver } from "../vendor.js";
import type { ExtractorContext, Repo } from "../interfaces/index.js";
import type { CodeIntelStore } from "../store.js";

let repoDir: string;

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), "ark-ci-git-"));
  runGit(repoDir, ["init", "-q"]);
  // Two commits by two different identities.
  runGit(repoDir, ["config", "user.email", "alice@example.com"]);
  runGit(repoDir, ["config", "user.name", "Alice"]);
  writeFileSync(join(repoDir, "a.ts"), "alpha\n");
  runGit(repoDir, ["add", "a.ts"]);
  runGit(repoDir, ["commit", "-q", "-m", "alice"]);

  runGit(repoDir, ["config", "user.email", "bob@example.com"]);
  runGit(repoDir, ["config", "user.name", "Bob"]);
  writeFileSync(join(repoDir, "b.ts"), "bravo\ndelta\n");
  runGit(repoDir, ["add", "b.ts"]);
  runGit(repoDir, ["commit", "-q", "-m", "bob"]);
});

afterAll(() => rmSync(repoDir, { recursive: true, force: true }));

describe("gitContributorsExtractor", () => {
  it("supports any git repo", () => {
    const repo: Repo = {
      id: "r",
      tenant_id: "t",
      repo_url: "file://" + repoDir,
      name: "r",
      default_branch: "main",
      local_path: repoDir,
    };
    expect(gitContributorsExtractor.supports(repo)).toBe(true);
  });

  it("declares people + contributions row kinds", () => {
    expect(gitContributorsExtractor.produces).toContain("people");
    expect(gitContributorsExtractor.produces).toContain("contributions");
  });

  it("yields one person + one contribution per identity", async () => {
    const repo: Repo = {
      id: "r",
      tenant_id: "t",
      repo_url: "file://" + repoDir,
      name: "r",
      default_branch: "main",
      local_path: repoDir,
    };
    const ctx: ExtractorContext = {
      repo,
      run: {
        id: "run-x",
        tenant_id: "t",
        repo_id: "r",
        branch: "main",
        status: "running",
        started_at: new Date().toISOString(),
      },
      store: {} as CodeIntelStore,
      vendor: new FilesystemVendorResolver(),
    };
    const rows: any[] = [];
    for await (const row of gitContributorsExtractor.run(ctx)) rows.push(row);
    const people = rows.filter((r) => r.kind === "people");
    const contribs = rows.filter((r) => r.kind === "contributions");
    expect(people.length).toBe(2);
    expect(contribs.length).toBe(2);
    const emails = people.map((r) => r.row.primary_email).sort();
    expect(emails).toEqual(["alice@example.com", "bob@example.com"]);
    const totalLoc = contribs.reduce((sum: number, r: any) => sum + r.row.loc_added, 0);
    expect(totalLoc).toBeGreaterThan(0);
  });
});

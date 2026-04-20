/**
 * files-extractor -- needs a real git repo so we mkdir a temp one,
 * commit a file, and assert the extractor yields a `files` row.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { filesExtractor } from "../extractors/files.js";
import { runGit } from "../util/git.js";
import { FilesystemVendorResolver } from "../vendor.js";
import type { ExtractorContext, Repo } from "../interfaces/index.js";
import type { CodeIntelStore } from "../store.js";

let repoDir: string;

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), "ark-ci-files-"));
  runGit(repoDir, ["init", "-q"]);
  runGit(repoDir, ["config", "user.email", "test@example.com"]);
  runGit(repoDir, ["config", "user.name", "Test"]);
  writeFileSync(join(repoDir, "hello.ts"), "export const hi = 'hello';\n");
  writeFileSync(join(repoDir, "README.md"), "# repo\n");
  runGit(repoDir, ["add", "."]);
  runGit(repoDir, ["commit", "-q", "-m", "init"]);
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("filesExtractor", () => {
  it("supports a git working tree", () => {
    const repo: Repo = {
      id: "r",
      tenant_id: "t",
      repo_url: "file://" + repoDir,
      name: "r",
      default_branch: "main",
      local_path: repoDir,
    };
    expect(filesExtractor.supports(repo)).toBe(true);
  });

  it("rejects a non-git path", () => {
    const repo: Repo = {
      id: "r",
      tenant_id: "t",
      repo_url: "file:///nope",
      name: "r",
      default_branch: "main",
      local_path: "/tmp/this-path-does-not-exist-ark-test",
    };
    expect(filesExtractor.supports(repo)).toBe(false);
  });

  it("yields one row per tracked file with sha + language", async () => {
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
    for await (const row of filesExtractor.run(ctx)) rows.push(row);
    expect(rows.length).toBe(2);
    const paths = rows.map((r) => r.row.path).sort();
    expect(paths).toEqual(["README.md", "hello.ts"]);
    const byPath = Object.fromEntries(rows.map((r) => [r.row.path, r.row]));
    expect(byPath["hello.ts"].language).toBe("typescript");
    expect(byPath["hello.ts"].sha.length).toBeGreaterThanOrEqual(7);
    expect(byPath["README.md"].language).toBe("markdown");
  });

  it("declares the right row kind", () => {
    expect(filesExtractor.produces).toContain("files");
    expect(filesExtractor.name).toBe("files");
  });
});

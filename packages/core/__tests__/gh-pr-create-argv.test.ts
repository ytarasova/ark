/**
 * Regression test: `gh pr create` argv must never carry `--repo`.
 *
 * Older `createWorktreePR` passed `--repo <session.repo>` where
 * `session.repo` is a local filesystem path like
 * `/Users/paytmlabs/Projects/ark`. `gh` expects `OWNER/NAME` for
 * `--repo` and rejected the call with "expected the [HOST/]OWNER/REPO
 * format". Since we already exec inside the worktree via `cwd`, `gh`
 * resolves owner/name from the git remote itself; the right answer is
 * "don't pass --repo, ever".
 */

import { describe, expect, test } from "bun:test";
import { buildGhPrCreateArgs } from "../services/worktree/pr.js";

describe("buildGhPrCreateArgs", () => {
  test("emits head / base / title / body", () => {
    const args = buildGhPrCreateArgs({
      head: "feat/x",
      base: "main",
      title: "My change",
      body: "Session: s-123",
    });
    expect(args).toEqual(["pr", "create", "--head", "feat/x", "--base", "main", "--title", "My change", "--body", "Session: s-123"]);
  });

  test("never emits --repo", () => {
    const args = buildGhPrCreateArgs({
      head: "feat/x",
      base: "main",
      title: "T",
      body: "B",
    });
    expect(args).not.toContain("--repo");
  });

  test("appends --draft when requested", () => {
    const args = buildGhPrCreateArgs({ head: "h", base: "b", title: "t", body: "B", draft: true });
    expect(args).toContain("--draft");
    expect(args.indexOf("--draft")).toBe(args.length - 1);
  });

  test("omits --draft by default", () => {
    const args = buildGhPrCreateArgs({ head: "h", base: "b", title: "t", body: "B" });
    expect(args).not.toContain("--draft");
  });
});

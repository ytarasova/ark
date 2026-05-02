/**
 * F3 regression: remote-dispatch workdir fallbacks must not silently leak
 * the conductor's local path. Pre-fix, when `provider.resolveWorkdir`
 * returned null (e.g. bare worktree dispatch with no `--remote-repo`),
 * both `launcherWorkdir` and the `runTargetLifecycle.workspace.remoteWorkdir`
 * field fell through to the conductor-side `effectiveWorkdir`. The launcher
 * then `cd`'d into a non-existent /Users/... path on Ubuntu and the
 * lifecycle asked prepare-workspace to clone into the same wrong path.
 *
 * Fix: `resolveRemoteWorkdirs` -- the launcher field falls back to a
 * remote-safe path (REMOTE_HOME = /home/ubuntu); the run-target field
 * falls back to null so prepareWorkspace skips cleanly.
 */
import { describe, it, expect } from "bun:test";

import { resolveRemoteWorkdirs } from "../executors/claude-code.js";

describe("resolveRemoteWorkdirs (F3)", () => {
  describe("local dispatch (isRemote=false)", () => {
    it("returns effectiveWorkdir for both fields", () => {
      const out = resolveRemoteWorkdirs({
        isRemote: false,
        effectiveWorkdir: "/Users/paytmlabs/Projects/ark/.ark/worktrees/s-1",
        resolveWorkdir: undefined,
      });
      expect(out.launcher).toBe("/Users/paytmlabs/Projects/ark/.ark/worktrees/s-1");
      expect(out.runTarget).toBe("/Users/paytmlabs/Projects/ark/.ark/worktrees/s-1");
    });
  });

  describe("remote dispatch with a real provider workdir", () => {
    it("uses the provider's resolveWorkdir result for both fields", () => {
      const out = resolveRemoteWorkdirs({
        isRemote: true,
        effectiveWorkdir: "/Users/paytmlabs/Projects/ark",
        resolveWorkdir: () => "/home/ubuntu/Projects/s-test/ark",
      });
      expect(out.launcher).toBe("/home/ubuntu/Projects/s-test/ark");
      expect(out.runTarget).toBe("/home/ubuntu/Projects/s-test/ark");
      // Sanity: neither field contains the conductor path.
      expect(out.launcher.includes("/Users/")).toBe(false);
      expect((out.runTarget ?? "").includes("/Users/")).toBe(false);
    });
  });

  describe("remote dispatch with NO clone source (resolveWorkdir returns null)", () => {
    it("launcher falls back to a remote-safe path under /home/ubuntu/", () => {
      const out = resolveRemoteWorkdirs({
        isRemote: true,
        effectiveWorkdir: "/Users/paytmlabs/Projects/ark",
        resolveWorkdir: () => null,
      });
      // Must NOT be /Users/...
      expect(out.launcher.includes("/Users/")).toBe(false);
      // Must be remote-safe.
      expect(out.launcher).toMatch(/^\/(home|workspace)\//);
      // Concrete shape: /home/ubuntu (matches REMOTE_HOME constant).
      expect(out.launcher).toBe("/home/ubuntu");
    });

    it("run-target falls back to null (so prepareWorkspace skips cleanly)", () => {
      const out = resolveRemoteWorkdirs({
        isRemote: true,
        effectiveWorkdir: "/Users/paytmlabs/Projects/ark",
        resolveWorkdir: () => null,
      });
      expect(out.runTarget).toBeNull();
    });

    it("invokes the onFallback hook with a descriptive reason", () => {
      const reasons: string[] = [];
      resolveRemoteWorkdirs({
        isRemote: true,
        effectiveWorkdir: "/Users/x/y",
        resolveWorkdir: () => null,
        onFallback: (r) => reasons.push(r),
      });
      expect(reasons.length).toBe(1);
      expect(reasons[0]).toContain("/home/ubuntu");
    });
  });

  describe("remote dispatch with NO resolveWorkdir hook at all", () => {
    it("treats undefined provider hook the same as null result -- launcher safe, target null", () => {
      const out = resolveRemoteWorkdirs({
        isRemote: true,
        effectiveWorkdir: "/Users/paytmlabs/Projects/ark",
        resolveWorkdir: undefined,
      });
      expect(out.launcher.includes("/Users/")).toBe(false);
      expect(out.launcher).toMatch(/^\/(home|workspace)\//);
      expect(out.runTarget).toBeNull();
    });
  });
});

describe("F3 launcher script content (smoke)", () => {
  /**
   * End-to-end-ish: the resolveRemoteWorkdirs result drives both
   * `claude.buildLauncher`'s `cd <workdir>` and the embedFiles' absolute
   * path resolution. Verify the surface those two consumers see is free
   * of `/Users/...`.
   */
  it("buildLauncher generated from a fallback workdir cd's into a remote-safe path", async () => {
    const { buildLauncher } = await import("../claude/launcher.js");

    const { launcher } = resolveRemoteWorkdirs({
      isRemote: true,
      effectiveWorkdir: "/Users/paytmlabs/Projects/ark",
      resolveWorkdir: () => null,
    });

    const { content } = buildLauncher({
      workdir: launcher,
      claudeArgs: ["claude"],
      mcpConfigPath: `${launcher}/.mcp.json`,
      embedFiles: [
        { relPath: ".mcp.json", content: "{}" },
        { relPath: ".claude/settings.local.json", content: "{}" },
      ],
    });

    // The launcher script has `cd '/home/ubuntu'`, not `cd /Users/...`.
    expect(content).toMatch(/cd ['"]?\/home\/ubuntu['"]?/);
    expect(content).not.toContain("/Users/");
    // The heredoc target paths derived from `<workdir>/<relPath>` must
    // NOT start with /Users/ either.
    expect(content).toContain("/home/ubuntu/.mcp.json");
    expect(content).toContain("/home/ubuntu/.claude/settings.local.json");
  });
});

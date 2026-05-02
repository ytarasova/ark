/**
 * F1/H5 regression: postCompactTaskHook must read `${ARK_SESSION_DIR}/task.txt`,
 * NOT a conductor-side `${HOME}/.ark/tracks/<id>/task.txt` path. The hook
 * command lands in `.claude/settings.local.json` on the host where claude
 * actually runs -- for remote dispatch (EC2 / k8s) that host is *not* the
 * conductor. Pre-fix, `process.env.HOME` (e.g. `/Users/paytmlabs`) was
 * baked into the command string at build time, the `[ -f $taskFile ]`
 * guard hid the breakage, and PostCompact task re-injection silently
 * no-opped on every remote session.
 */
import { describe, it, expect } from "bun:test";
import { homedir } from "os";

import { postCompactTaskHook } from "../claude/settings.js";

describe("postCompactTaskHook (F1/H5)", () => {
  it("references $ARK_SESSION_DIR (literal `$`, not expanded at build time)", () => {
    const hook = postCompactTaskHook("s-test123") as { command: string };
    expect(typeof hook.command).toBe("string");
    expect(hook.command).toContain("$ARK_SESSION_DIR/task.txt");
  });

  it("does NOT contain the conductor's HOME path", () => {
    // Capture the conductor's home before the call. If the hook builder ever
    // regresses to `process.env.HOME` / `os.homedir()`, this captured value
    // will appear in the command string and the assertion fires.
    const conductorHome = homedir();
    const envHome = process.env.HOME;
    const hook = postCompactTaskHook("s-abc") as { command: string };
    expect(hook.command.includes(conductorHome)).toBe(false);
    if (envHome) {
      expect(hook.command.includes(envHome)).toBe(false);
    }
  });

  it("does NOT reference $ARK_TEST_DIR or $HOME", () => {
    // The pre-fix command read `$HOME/.ark/...` (or `$ARK_TEST_DIR/...` in
    // tests). Both are conductor-side concepts; neither belongs in a hook
    // string that runs on the agent's host.
    const hook = postCompactTaskHook("s-xyz") as { command: string };
    expect(hook.command).not.toContain("$ARK_TEST_DIR");
    expect(hook.command).not.toContain("$HOME");
    expect(hook.command).not.toContain("${HOME}");
    expect(hook.command).not.toContain("/.ark/tracks/");
  });

  it("returns the standard hook shape (type=command, async=true)", () => {
    const hook = postCompactTaskHook("s-1") as Record<string, unknown>;
    expect(hook.type).toBe("command");
    expect(hook.async).toBe(true);
  });
});

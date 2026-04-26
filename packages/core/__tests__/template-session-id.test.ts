/**
 * `{{session_id}}` in YAML templates must resolve to the ark session id,
 * not the internal runtime-handle column.
 *
 * Pre-fix the Session row carried two near-identical fields:
 *   - `id`           -- the ark session id (always set)
 *   - `session_id`   -- the tmux/claude/agent-sdk runtime handle (often
 *                       null until the runtime is spawned)
 *
 * `buildSessionVars` spread the row into the var map, so `{{session_id}}`
 * picked up the runtime-handle column and rendered as `null` for every
 * spawn-child task whose runtime hadn't started yet. Real incident: the
 * v0.21.3/0.21.4 dispatch task included
 * `/home/ec2-user/.ark/worktrees/{{session_id}}/README.md` and the agent
 * saw `/home/ec2-user/.ark/worktrees/null/README.md`.
 *
 * The fix overrides `vars.session_id` with `session.id` so the template
 * always resolves to the ark id.
 */

import { describe, expect, test } from "bun:test";
import { buildSessionVars, substituteVars } from "../template.js";

describe("buildSessionVars -- session_id alias", () => {
  test("session_id resolves to the ark id, not the runtime handle", () => {
    const session = {
      id: "s-arkid",
      session_id: null, // runtime not spawned yet
      claude_session_id: null,
      summary: "test",
      flow: "bare",
    };
    const vars = buildSessionVars(session);
    expect(vars.session_id).toBe("s-arkid");
  });

  test("session_id stays as ark id even when the runtime handle is set", () => {
    // Don't leak the runtime handle into user-facing templates; users mean
    // "the session this is running in" when they write {{session_id}}.
    const session = {
      id: "s-arkid",
      session_id: "tmux-foo-runtime", // runtime spawned
      summary: "test",
      flow: "bare",
    };
    const vars = buildSessionVars(session);
    expect(vars.session_id).toBe("s-arkid");
  });

  test("template substitution renders the worktree path correctly", () => {
    // The exact pathology from the dispatch incident.
    const session = {
      id: "s-cb17uubc5w",
      session_id: null,
      summary: "smoke",
      flow: "bare",
    };
    const vars = buildSessionVars(session);
    const rendered = substituteVars("/home/ec2-user/.ark/worktrees/{{session_id}}/README.md", vars);
    expect(rendered).toBe("/home/ec2-user/.ark/worktrees/s-cb17uubc5w/README.md");
    expect(rendered).not.toContain("null");
  });

  test("a session with no id at all leaves session_id as whatever the row carried", () => {
    // Pure defensive sanity: don't overwrite when we have nothing better.
    const session = {
      id: null,
      session_id: "fallback-runtime-id",
    };
    const vars = buildSessionVars(session);
    expect(vars.session_id).toBe("fallback-runtime-id");
  });
});

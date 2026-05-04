/**
 * Stage stamping on every forwarded hook (#435 root cause #3).
 *
 * Each runtime instance is provisioned with its stage label baked in
 * (env var ARK_STAGE -> RunAgentSdkLaunchOpts.stage -> ForwardDeps.stage
 * -> messageToHooks(stage)). Once the agent is up, every hook it emits
 * carries that stage label. The conductor uses this as the source of
 * truth for event attribution instead of reading session.stage at log
 * time, which can flap mid-flight.
 *
 * The pre-fix behaviour: every event was stamped with whatever
 * session.stage read at write time. When the state machine flapped (e.g.
 * status-poller false-positive advanced session.stage prematurely while
 * the same agent kept emitting hooks), historical events ended up
 * tagged with the wrong stage. Reconciliation could not undo this --
 * the stage column is set in stone once the row is logged.
 */

import { describe, expect, test } from "bun:test";
import { messageToHooks } from "../launch.js";

const SID = "s-stage-stamp";

describe("messageToHooks -- stage stamping", () => {
  test("stamps stage on PreToolUse hooks", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "tool_1", name: "Bash", input: { command: "ls" } }],
      },
    };
    const hooks = messageToHooks(msg, SID, "implement");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hook_event_name).toBe("PreToolUse");
    expect(hooks[0].stage).toBe("implement");
  });

  test("stamps stage on PostToolUse hooks", () => {
    const msg = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool_1",
            content: "output",
            is_error: false,
          },
        ],
      },
    };
    const hooks = messageToHooks(msg, SID, "verify");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hook_event_name).toBe("PostToolUse");
    expect(hooks[0].stage).toBe("verify");
  });

  test("stamps stage on AgentMessage hooks (text + thinking)", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "looking at the code" },
          { type: "thinking", thinking: "let me reason..." },
        ],
      },
    };
    const hooks = messageToHooks(msg, SID, "pr");
    expect(hooks).toHaveLength(2);
    expect(hooks.every((h) => h.stage === "pr")).toBe(true);
  });

  test("stamps stage on SessionStart", () => {
    const msg = { type: "system", subtype: "init", model: "claude-3", tools: [], cwd: "/tmp" };
    const hooks = messageToHooks(msg, SID, "implement");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].hook_event_name).toBe("SessionStart");
    expect(hooks[0].stage).toBe("implement");
  });

  test("stamps stage on Stop + SessionEnd (the result fanout)", () => {
    const msg = {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.5,
      usage: { input_tokens: 10, output_tokens: 20 },
      num_turns: 1,
      duration_ms: 1000,
    };
    const hooks = messageToHooks(msg, SID, "verify");
    // result emits both Stop AND a transition hook (SessionEnd here).
    expect(hooks.length).toBeGreaterThanOrEqual(2);
    expect(hooks.every((h) => h.stage === "verify")).toBe(true);
  });

  test("omits stage field entirely when stage is null/undefined/empty", () => {
    // Backward-compat: legacy callers / tests pass no stage. The hook
    // shape must not gain a `stage: null` key (would break consumer
    // expectations) -- the field is present iff stage is truthy.
    const msg = {
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    };
    expect(messageToHooks(msg, SID)[0]).not.toHaveProperty("stage");
    expect(messageToHooks(msg, SID, null)[0]).not.toHaveProperty("stage");
    expect(messageToHooks(msg, SID, "")[0]).not.toHaveProperty("stage");
  });

  test("preserves stage through PostToolUse with parallel tool_use blocks", () => {
    const msg = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "a", is_error: false },
          { type: "tool_result", tool_use_id: "t2", content: "b", is_error: true },
        ],
      },
    };
    const hooks = messageToHooks(msg, SID, "implement");
    expect(hooks).toHaveLength(2);
    expect(hooks.every((h) => h.stage === "implement")).toBe(true);
  });
});

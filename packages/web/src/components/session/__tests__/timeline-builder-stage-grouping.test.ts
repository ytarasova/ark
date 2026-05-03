/**
 * groupTimelineByStage: bucket flat timeline items into per-stage groups,
 * extract artifacts from event payloads, and derive group status from the
 * session row + event signals.
 */

import { describe, it, expect } from "bun:test";
import { buildConversationTimeline, groupTimelineByStage } from "../timeline-builder.js";

function ev(type: string, opts: { stage?: string; data?: any; created_at?: string }): any {
  return {
    type,
    stage: opts.stage,
    data: opts.data,
    created_at: opts.created_at ?? "2026-05-03T20:00:00.000Z",
  };
}

describe("groupTimelineByStage", () => {
  it("buckets items by stage in arrival order", () => {
    const events = [
      ev("stage_started", { stage: "implement", data: { agent: "implementer" }, created_at: "2026-05-03T20:00:00Z" }),
      ev("hook_status", {
        stage: "implement",
        data: { event: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
        created_at: "2026-05-03T20:00:05Z",
      }),
      ev("hook_status", {
        stage: "implement",
        data: { event: "PostToolUse", tool_name: "Bash", tool_response: "" },
        created_at: "2026-05-03T20:00:06Z",
      }),
      ev("stage_started", { stage: "verify", data: { agent: "verifier" }, created_at: "2026-05-03T20:00:10Z" }),
      ev("hook_status", {
        stage: "verify",
        data: { event: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x" } },
        created_at: "2026-05-03T20:00:11Z",
      }),
    ];
    const timeline = buildConversationTimeline(events, [], { status: "running", stage: "verify" });

    const groups = groupTimelineByStage(timeline, events, { status: "running", stage: "verify" });
    const named = groups.filter((g) => g.name != null);

    expect(named.length).toBe(2);
    expect(named[0].name).toBe("implement");
    expect(named[1].name).toBe("verify");
  });

  it("attaches PR url + branch from pr_created to its stage", () => {
    const events = [
      ev("stage_started", { stage: "pr", data: { agent: "pr-handler" } }),
      ev("pr_created", {
        stage: "pr",
        data: { pr_url: "https://github.com/acme/repo/pull/42", branch: "feat/x", remote: true },
      }),
    ];
    const timeline = buildConversationTimeline(events, [], { status: "running", stage: "pr" });
    const groups = groupTimelineByStage(timeline, events, { status: "running", stage: "pr" });

    const pr = groups.find((g) => g.name === "pr")!;
    expect(pr).toBeDefined();
    expect(pr.artifacts.prUrl).toBe("https://github.com/acme/repo/pull/42");
    expect(pr.artifacts.branch).toBe("feat/x");
  });

  it("counts distinct files touched via Edit/Write tool calls", () => {
    const events = [
      ev("stage_started", { stage: "implement", data: { agent: "implementer" } }),
      ev("hook_status", {
        stage: "implement",
        data: { event: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/a.ts" } },
      }),
      ev("hook_status", {
        stage: "implement",
        data: { event: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/b.ts" } },
      }),
      ev("hook_status", {
        stage: "implement",
        data: { event: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/a.ts" } },
      }),
    ];
    const timeline = buildConversationTimeline(events, [], { status: "running", stage: "implement" });
    const groups = groupTimelineByStage(timeline, events, { status: "running", stage: "implement" });

    const impl = groups.find((g) => g.name === "implement")!;
    expect(impl.artifacts.filesTouched).toEqual(["/a.ts", "/b.ts"]);
  });

  it("counts git commit invocations from Bash tool calls", () => {
    const events = [
      ev("stage_started", { stage: "implement", data: { agent: "implementer" } }),
      ev("hook_status", {
        stage: "implement",
        data: { event: "PreToolUse", tool_name: "Bash", tool_input: { command: "git add . && git commit -m 'x'" } },
      }),
      ev("hook_status", {
        stage: "implement",
        data: { event: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push" } },
      }),
      ev("hook_status", {
        stage: "implement",
        data: { event: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit --amend" } },
      }),
    ];
    const timeline = buildConversationTimeline(events, [], { status: "running", stage: "implement" });
    const groups = groupTimelineByStage(timeline, events, { status: "running", stage: "implement" });

    const impl = groups.find((g) => g.name === "implement")!;
    expect(impl.artifacts.commits).toBe(2);
  });

  it("derives stage status: current stage running -> active; earlier stages -> done", () => {
    const events = [
      ev("stage_started", { stage: "implement", data: { agent: "implementer" }, created_at: "2026-05-03T20:00:00Z" }),
      ev("stage_handoff", {
        stage: "implement",
        data: { from_stage: "implement", to_stage: "verify" },
        created_at: "2026-05-03T20:00:30Z",
      }),
      ev("stage_started", { stage: "verify", data: { agent: "verifier" }, created_at: "2026-05-03T20:00:31Z" }),
    ];
    const timeline = buildConversationTimeline(events, [], { status: "running", stage: "verify" });
    const groups = groupTimelineByStage(timeline, events, { status: "running", stage: "verify" });

    const impl = groups.find((g) => g.name === "implement")!;
    const verify = groups.find((g) => g.name === "verify")!;
    expect(impl.status).toBe("done");
    expect(verify.status).toBe("active");
  });

  it("derives failed status when current stage hit a dispatch_failed", () => {
    const events = [
      ev("stage_started", { stage: "merge", data: { agent: "merger" } }),
      ev("dispatch_failed", { stage: "merge", data: { reason: "Action 'auto_merge' failed" } }),
    ];
    const timeline = buildConversationTimeline(events, [], { status: "failed", stage: "merge" });
    const groups = groupTimelineByStage(timeline, events, { status: "failed", stage: "merge" });

    const merge = groups.find((g) => g.name === "merge")!;
    expect(merge.status).toBe("failed");
  });

  it("clamps post-current stages to pending regardless of historical events (#435)", () => {
    // The bug repro: agent at stage="verify" still running, but old buggy
    // events (from a status-poller false-positive that prematurely
    // advanced session.stage and then was reconciled back) tagged events
    // with stage="pr" and stage="merge". The display must NOT show
    // "STAGE 3 pr DONE" while STAGE 2 is still running -- a stage strictly
    // after session.stage in the canonical flow ordering is pending.
    const events = [
      ev("stage_started", { stage: "implement", data: { agent: "implementer" } }),
      ev("stage_handoff", {
        stage: "implement",
        data: { from_stage: "implement", to_stage: "verify" },
      }),
      // legacy stamping from the bug period -- pretends pr + merge were reached
      ev("action_executed", { stage: "pr", data: { action: "create_pr" } }),
      ev("stage_handoff", { stage: "pr", data: { from_stage: "pr", to_stage: "merge" } }),
      ev("hook_status", {
        stage: "merge",
        data: { event: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
      }),
    ];
    const timeline = buildConversationTimeline(events, [], { status: "running", stage: "verify", flow: "quick" });
    const groups = groupTimelineByStage(timeline, events, { status: "running", stage: "verify", flow: "quick" }, [
      "implement",
      "verify",
      "pr",
      "merge",
    ]);

    const pr = groups.find((g) => g.name === "pr");
    const merge = groups.find((g) => g.name === "merge");
    expect(pr?.status).toBe("pending");
    expect(merge?.status).toBe("pending");
  });

  it("attaches null-stage items to the most recent named stage when one exists", () => {
    // First stage_started event sets the cursor; a later message-only item
    // (no stage) should fold into that stage rather than the leading null
    // bucket.
    const events = [ev("stage_started", { stage: "implement", data: { agent: "implementer" } })];
    const messages = [
      { role: "assistant", content: "thinking", created_at: "2026-05-03T20:00:01Z", agent_name: "implementer" },
    ];
    const timeline = buildConversationTimeline(events, messages, { status: "running", stage: "implement" });
    const groups = groupTimelineByStage(timeline, events, { status: "running", stage: "implement" });

    const impl = groups.find((g) => g.name === "implement");
    expect(impl).toBeDefined();
    // The agent message has no stage but should fold into "implement"
    expect(impl!.items.some((it: any) => it.kind === "agent")).toBe(true);
  });
});

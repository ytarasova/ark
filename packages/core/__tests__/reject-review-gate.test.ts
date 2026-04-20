/**
 * Tests for rejectReviewGate -- the counterpart to approveReviewGate.
 *
 * rejectReviewGate renders on_reject.prompt (with {{rejection_reason}}),
 * persists rework state, bumps rejection_count, and re-dispatches. When
 * max_rejections is exceeded the session is marked failed instead.
 *
 * The real dispatch path needs tmux + an executor, which tests can't spin
 * up reliably, so we pass a stub `dispatchFn` into the direct lifecycle
 * entrypoint. The orchestration barrel wires the real dispatch in
 * production; both paths go through the same rejectReviewGate core.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";

import { startSession, renderReworkPrompt, rejectReviewGate } from "../services/session-lifecycle.js";
import { advance } from "../services/session-orchestration.js";
import { withTestContext, getApp } from "./test-helpers.js";

withTestContext();

const flowDir = () => join(getApp().config.arkDir, "flows");

function writeUserFlow(name: string, def: Record<string, unknown>): void {
  const dir = flowDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(def));
}

beforeEach(() => {
  rmSync(flowDir(), { recursive: true, force: true });
});

// ── renderReworkPrompt ──────────────────────────────────────────────────────

describe("renderReworkPrompt", () => {
  it("substitutes {{rejection_reason}} (Archon-style double-brace)", () => {
    const out = renderReworkPrompt("Reviewer said: {{rejection_reason}}", "tests missing", {});
    expect(out).toBe("Reviewer said: tests missing");
  });

  it("also substitutes single-brace session vars", () => {
    const out = renderReworkPrompt("Stage {stage}: {{rejection_reason}}", "no coverage", { stage: "review" });
    expect(out).toBe("Stage review: no coverage");
  });

  it("handles the single-brace form of rejection_reason", () => {
    const out = renderReworkPrompt("Reason: {rejection_reason}", "foo", {});
    expect(out).toBe("Reason: foo");
  });

  it("leaves unknown variables intact", () => {
    const out = renderReworkPrompt("Hi {unknown}", "x", {});
    expect(out).toBe("Hi {unknown}");
  });
});

// ── rejectReviewGate happy path ─────────────────────────────────────────────

describe("rejectReviewGate", () => {
  it("renders declared on_reject.prompt and dispatches a rework", async () => {
    writeUserFlow("reject-custom", {
      name: "reject-custom",
      stages: [
        {
          name: "qa",
          agent: "reviewer",
          gate: "review",
          on_reject: {
            prompt: "Fix this: {{rejection_reason}}",
          },
        },
        { name: "deploy", agent: "deployer", gate: "auto" },
      ],
    });

    const session = startSession(getApp(), { flow: "reject-custom", summary: "custom reject" });
    expect(session.stage).toBe("qa");

    let dispatched = 0;
    const result = await rejectReviewGate(getApp(), session.id, "tests are missing", async () => {
      dispatched++;
      return { ok: true, message: "dispatched" };
    });

    expect(result.ok).toBe(true);
    expect(dispatched).toBe(1);

    const after = getApp().sessions.get(session.id)!;
    expect(after.stage).toBe("qa"); // still on the same stage
    expect(after.rejection_count).toBe(1);
    expect(after.rejected_reason).toBe("tests are missing");
    expect(after.rejected_at).toBeTruthy();
    expect(after.rework_prompt).toBe("Fix this: tests are missing");

    const events = getApp().events.list(session.id, { type: "review_rejected" });
    expect(events.length).toBe(1);
    expect(events[0].data?.reason).toBe("tests are missing");
    expect(events[0].data?.rejection_count).toBe(1);
  });

  it("falls back to the default prompt when on_reject.prompt is not declared", async () => {
    writeUserFlow("reject-default", {
      name: "reject-default",
      stages: [
        { name: "review-me", agent: "reviewer", gate: "review" },
        { name: "done", agent: "deployer", gate: "auto" },
      ],
    });

    const session = startSession(getApp(), { flow: "reject-default", summary: "default" });
    const result = await rejectReviewGate(getApp(), session.id, "needs more tests", async () => ({
      ok: true,
      message: "ok",
    }));
    expect(result.ok).toBe(true);

    const after = getApp().sessions.get(session.id)!;
    expect(after.rework_prompt).toBe("Rework required. Reviewer said: needs more tests");
    expect(after.rejection_count).toBe(1);
  });

  it("accepts gate: 'manual' too (same human-approval semantic)", async () => {
    writeUserFlow("reject-manual", {
      name: "reject-manual",
      stages: [{ name: "sign-off", agent: "reviewer", gate: "manual" }],
    });

    const session = startSession(getApp(), { flow: "reject-manual", summary: "manual gate" });
    const res = await rejectReviewGate(getApp(), session.id, "nope", async () => ({ ok: true, message: "ok" }));
    expect(res.ok).toBe(true);
    expect(getApp().sessions.get(session.id)!.rejection_count).toBe(1);
  });

  it("rejects when stage gate is not review/manual", async () => {
    writeUserFlow("reject-auto", {
      name: "reject-auto",
      stages: [{ name: "build", agent: "builder", gate: "auto" }],
    });
    const session = startSession(getApp(), { flow: "reject-auto", summary: "auto" });
    const res = await rejectReviewGate(getApp(), session.id, "nope", async () => ({ ok: true, message: "ok" }));
    expect(res.ok).toBe(false);
    expect(res.message).toContain("'auto'");
  });

  it("returns an error when the session does not exist", async () => {
    const res = await rejectReviewGate(getApp(), "s-missing", "why", async () => ({ ok: true, message: "x" }));
    expect(res.ok).toBe(false);
    expect(res.message).toContain("not found");
  });

  it("clears claude_session_id + session_id so dispatch starts fresh", async () => {
    writeUserFlow("reject-clear", {
      name: "reject-clear",
      stages: [{ name: "review", agent: "reviewer", gate: "review" }],
    });
    const session = startSession(getApp(), { flow: "reject-clear", summary: "clear" });
    // Pre-populate runtime ids to verify they're nulled out.
    getApp().sessions.update(session.id, {
      claude_session_id: "prev-claude",
      session_id: "ark-s-prev",
    });

    await rejectReviewGate(getApp(), session.id, "rework", async () => ({ ok: true, message: "ok" }));

    const after = getApp().sessions.get(session.id)!;
    expect(after.claude_session_id).toBeNull();
    expect(after.session_id).toBeNull();
    expect(after.status).toBe("ready");
  });
});

// ── max_rejections cap ──────────────────────────────────────────────────────

describe("rejectReviewGate max_rejections", () => {
  it("marks the session failed when the cap is hit", async () => {
    writeUserFlow("reject-cap", {
      name: "reject-cap",
      stages: [
        {
          name: "review",
          agent: "reviewer",
          gate: "review",
          on_reject: { prompt: "please redo: {{rejection_reason}}", max_rejections: 2 },
        },
      ],
    });

    const session = startSession(getApp(), { flow: "reject-cap", summary: "cap" });

    let dispatchCount = 0;
    const stubDispatch = async () => {
      dispatchCount++;
      return { ok: true, message: "ok" };
    };

    // First reject -> rework_count becomes 1
    let res = await rejectReviewGate(getApp(), session.id, "r1", stubDispatch);
    expect(res.ok).toBe(true);
    expect(getApp().sessions.get(session.id)!.rejection_count).toBe(1);
    expect(dispatchCount).toBe(1);

    // Second reject -> rework_count becomes 2 (still within cap since 1 < 2)
    res = await rejectReviewGate(getApp(), session.id, "r2", stubDispatch);
    expect(res.ok).toBe(true);
    expect(getApp().sessions.get(session.id)!.rejection_count).toBe(2);
    expect(dispatchCount).toBe(2);

    // Third reject -> cap hit (2 >= 2), session fails, no dispatch.
    res = await rejectReviewGate(getApp(), session.id, "r3", stubDispatch);
    expect(res.ok).toBe(false);
    expect(res.message).toBe("max_rejections exceeded");
    expect(dispatchCount).toBe(2);

    const after = getApp().sessions.get(session.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toBe("max_rejections exceeded");

    // Confirm both the review_rejected (capped) and session_failed events were logged.
    const rejectedEvents = getApp().events.list(session.id, { type: "review_rejected" });
    const capped = rejectedEvents.find((e) => e.data?.capped);
    expect(capped).toBeTruthy();
    expect(capped!.data?.rejection_count).toBe(2);

    const failedEvents = getApp().events.list(session.id, { type: "session_failed" });
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0].data?.reason).toBe("max_rejections exceeded");
  });

  it("treats max_rejections=0 as 'no reworks allowed'", async () => {
    writeUserFlow("reject-zero", {
      name: "reject-zero",
      stages: [
        {
          name: "review",
          agent: "reviewer",
          gate: "review",
          on_reject: { max_rejections: 0 },
        },
      ],
    });
    const session = startSession(getApp(), { flow: "reject-zero", summary: "zero" });
    let dispatched = 0;
    const res = await rejectReviewGate(getApp(), session.id, "no", async () => {
      dispatched++;
      return { ok: true, message: "x" };
    });
    expect(res.ok).toBe(false);
    expect(res.message).toBe("max_rejections exceeded");
    expect(dispatched).toBe(0);
    expect(getApp().sessions.get(session.id)!.status).toBe("failed");
  });
});

// ── Integration: reject -> re-dispatch -> approve -> advance ────────────────
//
// Uses advance() (not dispatch, which requires tmux) to confirm the
// rework + approve handoff lands us on the next stage. The rework prompt
// would be delivered by a real dispatch; this test asserts the *state
// transitions* around the rework step, not the prompt text.

describe("review gate integration", () => {
  it("reject -> dispatch -> approve advances past the gate", async () => {
    writeUserFlow("integration", {
      name: "integration",
      stages: [
        {
          name: "review",
          agent: "reviewer",
          gate: "review",
          on_reject: { prompt: "redo: {{rejection_reason}}" },
        },
        { name: "ship", agent: "deployer", gate: "auto" },
      ],
    });

    const session = startSession(getApp(), { flow: "integration", summary: "integration" });
    expect(session.stage).toBe("review");

    // Reject with a stub dispatch to simulate rework.
    const res = await rejectReviewGate(getApp(), session.id, "add tests", async () => ({ ok: true, message: "ok" }));
    expect(res.ok).toBe(true);
    const afterReject = getApp().sessions.get(session.id)!;
    expect(afterReject.stage).toBe("review"); // still here
    expect(afterReject.rework_prompt).toBe("redo: add tests");

    // Now approve (force-advance). Uses the real advance which does NOT touch tmux.
    const { approveReviewGate } = await import("../services/session-orchestration.js");
    const approve = await approveReviewGate(getApp(), session.id);
    expect(approve.ok).toBe(true);
    expect(getApp().sessions.get(session.id)!.stage).toBe("ship");

    // Safety: advance past the final auto gate to confirm the flow finished cleanly.
    await advance(getApp(), session.id, true);
  });
});

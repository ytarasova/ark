/**
 * Tests for the review gate type — blocks flow until PR is approved,
 * then approveReviewGate() force-advances past the gate.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";

import { ARK_DIR } from "../store.js";
import * as store from "../store.js";
import { startSession, advance, approveReviewGate } from "../session.js";
import { loadFlow, evaluateGate } from "../flow.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

const flowDir = () => join(ARK_DIR(), "flows");

function writeUserFlow(name: string, def: Record<string, unknown>): void {
  const dir = flowDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(def));
}

beforeEach(() => {
  rmSync(flowDir(), { recursive: true, force: true });
});

// ── approveReviewGate ─────────────────────────────────────────────────────

describe("approveReviewGate", () => {
  it("advances a session at a review stage", () => {
    writeUserFlow("pr-flow", {
      name: "pr-flow",
      stages: [
        { name: "code", agent: "implementer", gate: "auto" },
        { name: "wait-review", agent: "reviewer", gate: "review" },
        { name: "deploy", agent: "deployer", gate: "auto" },
      ],
    });

    const session = startSession({ flow: "pr-flow", summary: "test review gate" });
    // startSession puts us at stage "code" — advance past auto gate to "wait-review"
    const adv = advance(session.id, true);
    expect(adv.ok).toBe(true);
    expect(adv.message).toContain("wait-review");

    const atReview = store.getSession(session.id)!;
    expect(atReview.stage).toBe("wait-review");

    // Normal advance should be blocked by review gate
    const blocked = advance(session.id);
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain("awaiting PR approval");

    // approveReviewGate force-advances
    const result = approveReviewGate(session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("deploy");

    const after = store.getSession(session.id)!;
    expect(after.stage).toBe("deploy");
  });

  it("returns error for nonexistent session", () => {
    const result = approveReviewGate("s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("logs review_approved event", () => {
    writeUserFlow("rev-evt", {
      name: "rev-evt",
      stages: [
        { name: "wait", agent: "reviewer", gate: "review" },
        { name: "next", agent: "deployer", gate: "auto" },
      ],
    });

    const session = startSession({ flow: "rev-evt", summary: "event test" });
    approveReviewGate(session.id);

    const events = store.getEvents(session.id, { type: "review_approved" });
    expect(events.length).toBe(1);
    expect(events[0].actor).toBe("github");
    expect(events[0].stage).toBe("wait");
  });
});

// ── Review gate blocks until approved ────────────────────────────────────

describe("review gate blocking", () => {
  it("session with review gate blocks until approved", () => {
    writeUserFlow("block-flow", {
      name: "block-flow",
      stages: [
        { name: "review-stage", agent: "reviewer", gate: "review" },
        { name: "final", agent: "deployer", gate: "auto" },
      ],
    });

    const session = startSession({ flow: "block-flow", summary: "block test" });
    expect(session.stage).toBe("review-stage");

    // Gate blocks
    const gateResult = evaluateGate("block-flow", "review-stage", {});
    expect(gateResult.canProceed).toBe(false);

    // Normal advance blocked
    const advResult = advance(session.id);
    expect(advResult.ok).toBe(false);

    // Approve unblocks
    const approved = approveReviewGate(session.id);
    expect(approved.ok).toBe(true);

    const final = store.getSession(session.id)!;
    expect(final.stage).toBe("final");
  });
});

// ── Flow with review stage loads from YAML ───────────────────────────────

describe("review flow YAML loading", () => {
  it("flow with review stage loads correctly from YAML", () => {
    writeUserFlow("yaml-review", {
      name: "yaml-review",
      description: "Flow with review gate",
      stages: [
        { name: "build", agent: "builder", gate: "auto" },
        { name: "pr-review", agent: "reviewer", gate: "review" },
        { name: "ship", agent: "deployer", gate: "auto" },
      ],
    });

    const flow = loadFlow("yaml-review");
    expect(flow).not.toBeNull();
    expect(flow!.name).toBe("yaml-review");
    expect(flow!.stages).toHaveLength(3);

    const reviewStage = flow!.stages[1];
    expect(reviewStage.name).toBe("pr-review");
    expect(reviewStage.gate).toBe("review");
    expect(reviewStage.agent).toBe("reviewer");
  });
});

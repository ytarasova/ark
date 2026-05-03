/**
 * Tests for quality gate enforcement in autonomous flows.
 *
 * Validates that the autonomous-sdlc flow enforces quality gates via:
 * 1. The verify stage exists and is wired into the DAG correctly
 * 2. Repo config verify scripts block handoff from the verify stage
 * 3. Failing verify scripts prevent advancement to the review stage
 * 4. Passing verify scripts allow advancement to the review stage
 * 5. The full autonomous-sdlc pipeline respects verification at each transition
 * 6. Todos block verify stage handoff in autonomous flows
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AppContext } from "../app.js";
import * as flow from "../state/flow.js";

let app: AppContext;

beforeEach(async () => {
  if (app) {
    await app.shutdown();
  }
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  // no-op -- beforeEach handles cleanup
});

// ── Helper: create a workdir with .ark.yaml verify scripts ──

function createWorkdirWithVerify(scripts: string[]): string {
  const dir = join(app.arkDir, `workdir-qg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const yaml = ["verify:", ...scripts.map((s) => `  - "${s}"`)].join("\n");
  writeFileSync(join(dir, ".ark.yaml"), yaml);
  return dir;
}

// ── 1. Flow structure: verify stage exists in autonomous-sdlc ──────────

describe("autonomous-sdlc flow structure", () => {
  it("has a verify stage", () => {
    const stages = flow.getStages(app, "autonomous-sdlc");
    const verifyStage = stages.find((s) => s.name === "verify");
    expect(verifyStage).toBeTruthy();
  });

  it("verify stage uses the verifier agent", () => {
    const stage = flow.getStage(app, "autonomous-sdlc", "verify");
    expect(stage).toBeTruthy();
    expect(stage!.agent).toBe("verifier");
  });

  it("verify stage has auto gate", () => {
    const stage = flow.getStage(app, "autonomous-sdlc", "verify");
    expect(stage!.gate).toBe("auto");
  });

  it("verify stage depends on implement", () => {
    const stage = flow.getStage(app, "autonomous-sdlc", "verify");
    expect(stage!.depends_on).toEqual(["implement"]);
  });

  it("review stage depends on verify (not implement)", () => {
    const stage = flow.getStage(app, "autonomous-sdlc", "review");
    expect(stage!.depends_on).toEqual(["verify"]);
  });

  it("stages are ordered: plan -> implement -> verify -> review -> pr", () => {
    // The merge action stage was removed in #436 -- the pr-handler agent
    // now owns both create_pr + queue auto-merge in a single stage.
    const stages = flow.getStages(app, "autonomous-sdlc");
    const names = stages.map((s) => s.name);
    expect(names).toEqual(["plan", "implement", "verify", "review", "pr"]);
  });

  it("verify stage has on_failure retry", () => {
    const stage = flow.getStage(app, "autonomous-sdlc", "verify");
    expect(stage!.on_failure).toBe("retry(2)");
  });

  it("verify stage has a task prompt", () => {
    const stage = flow.getStage(app, "autonomous-sdlc", "verify");
    expect(stage!.task).toBeTruthy();
    expect(stage!.task).toContain("verification");
  });
});

// ── 2. DAG correctness ─────────────────────────────────────────────────

describe("autonomous-sdlc DAG validation", () => {
  it("DAG is valid (no cycles, all refs exist)", () => {
    const stages = flow.getStages(app, "autonomous-sdlc");
    expect(() => flow.validateDAG(stages)).not.toThrow();
  });

  it("implement is ready after plan completes", () => {
    const stages = flow.getStages(app, "autonomous-sdlc");
    const ready = flow.getReadyStages(stages, ["plan"]);
    const readyNames = ready.map((s) => s.name);
    expect(readyNames).toContain("implement");
    expect(readyNames).not.toContain("verify");
  });

  it("verify is ready after implement completes", () => {
    const stages = flow.getStages(app, "autonomous-sdlc");
    const ready = flow.getReadyStages(stages, ["plan", "implement"]);
    const readyNames = ready.map((s) => s.name);
    expect(readyNames).toContain("verify");
    expect(readyNames).not.toContain("review");
  });

  it("review is ready after verify completes", () => {
    const stages = flow.getStages(app, "autonomous-sdlc");
    const ready = flow.getReadyStages(stages, ["plan", "implement", "verify"]);
    const readyNames = ready.map((s) => s.name);
    expect(readyNames).toContain("review");
  });

  it("review is NOT ready if only implement completes (verify missing)", () => {
    const stages = flow.getStages(app, "autonomous-sdlc");
    const ready = flow.getReadyStages(stages, ["plan", "implement"]);
    const readyNames = ready.map((s) => s.name);
    expect(readyNames).not.toContain("review");
  });
});

// ── 3. Verify stage handoff with repo config scripts ───────────────────

describe("verify stage quality gate enforcement", async () => {
  it("blocks handoff from verify when repo config scripts fail", async () => {
    const workdir = createWorkdirWithVerify(["exit 1"]);
    const session = await app.sessions.create({ summary: "qg block test", flow: "autonomous-sdlc" });
    await app.sessions.update(session.id, { status: "ready", stage: "verify", workdir });

    const result = await app.sessionHooks.mediateStageHandoff(session.id, {
      autoDispatch: false,
      source: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.blockedByVerification).toBe(true);
    expect(result.fromStage).toBe("verify");

    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.breakpoint_reason).toContain("Verification failed");
  });

  it("allows handoff from verify when repo config scripts pass", async () => {
    const workdir = createWorkdirWithVerify(["true"]);
    const session = await app.sessions.create({ summary: "qg pass test", flow: "autonomous-sdlc" });
    await app.sessions.update(session.id, { status: "ready", stage: "verify", workdir });

    const result = await app.sessionHooks.mediateStageHandoff(session.id, {
      autoDispatch: false,
      source: "test",
    });

    expect(result.ok).toBe(true);
    expect(result.toStage).toBe("review");

    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).toBe("review");
    expect(updated?.status).toBe("ready");
  });

  it("captures verify script output on failure", async () => {
    const workdir = createWorkdirWithVerify(["echo quality-gate-failed >&2 && exit 1"]);
    const session = await app.sessions.create({ summary: "qg output test", flow: "autonomous-sdlc" });
    await app.sessions.update(session.id, { status: "ready", stage: "verify", workdir });

    const result = await app.sessionLifecycle.runVerification(session.id);

    expect(result.ok).toBe(false);
    expect(result.scriptResults).toHaveLength(1);
    expect(result.scriptResults[0].passed).toBe(false);
    expect(result.scriptResults[0].output).toContain("quality-gate-failed");
  });

  it("runs multiple verify scripts and blocks on partial failure", async () => {
    const workdir = createWorkdirWithVerify(["true", "exit 1", "true"]);
    const session = await app.sessions.create({ summary: "qg partial fail", flow: "autonomous-sdlc" });
    await app.sessions.update(session.id, { status: "ready", stage: "verify", workdir });

    const result = await app.sessionLifecycle.runVerification(session.id);

    expect(result.ok).toBe(false);
    expect(result.scriptResults).toHaveLength(3);
    expect(result.scriptResults[0].passed).toBe(true);
    expect(result.scriptResults[1].passed).toBe(false);
    expect(result.scriptResults[2].passed).toBe(true);
  });
});

// ── 4. Todos block verify stage in autonomous flows ────────────────────

describe("todo enforcement at verify stage", async () => {
  it("unresolved todos block verify stage handoff", async () => {
    const session = await app.sessions.create({ summary: "qg todo block", flow: "autonomous-sdlc" });
    await app.sessions.update(session.id, { status: "ready", stage: "verify" });
    await app.todos.add(session.id, "Fix test coverage");

    const result = await app.sessionHooks.mediateStageHandoff(session.id, {
      autoDispatch: false,
      source: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.blockedByVerification).toBe(true);

    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("blocked");
  });

  it("resolved todos allow verify stage handoff", async () => {
    const session = await app.sessions.create({ summary: "qg todo pass", flow: "autonomous-sdlc" });
    await app.sessions.update(session.id, { status: "ready", stage: "verify" });
    const todo = await app.todos.add(session.id, "Fix test coverage");
    await app.todos.toggle(todo.id);

    const result = await app.sessionHooks.mediateStageHandoff(session.id, {
      autoDispatch: false,
      source: "test",
    });

    expect(result.ok).toBe(true);
    expect(result.toStage).toBe("review");
  });
});

// ── 5. Full pipeline: implement -> verify -> review advancement ────────

describe("autonomous-sdlc pipeline with quality gates", async () => {
  it("advances implement -> verify -> review with passing scripts", async () => {
    const workdir = createWorkdirWithVerify(["true"]);
    const session = await app.sessions.create({ summary: "pipeline test", flow: "autonomous-sdlc" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });

    // implement -> verify
    const r1 = await app.sessionHooks.mediateStageHandoff(session.id, {
      autoDispatch: false,
      source: "test",
    });
    expect(r1.ok).toBe(true);
    expect(r1.toStage).toBe("verify");

    // verify -> review
    const r2 = await app.sessionHooks.mediateStageHandoff(session.id, {
      autoDispatch: false,
      source: "test",
    });
    expect(r2.ok).toBe(true);
    expect(r2.toStage).toBe("review");

    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).toBe("review");
    expect(updated?.status).toBe("ready");
  });

  it("blocks at verify stage -- does NOT reach review", async () => {
    // Start without verify scripts so implement -> verify advances cleanly
    const dir = join(app.arkDir, `workdir-block-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    const session = await app.sessions.create({ summary: "pipeline block test", flow: "autonomous-sdlc" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement", workdir: dir });

    // implement -> verify: advances (no verify scripts configured yet)
    const r1 = await app.sessionHooks.mediateStageHandoff(session.id, {
      autoDispatch: false,
      source: "test",
    });
    expect(r1.ok).toBe(true);
    expect(r1.toStage).toBe("verify");

    // Now add failing verify scripts to repo config
    writeFileSync(join(dir, ".ark.yaml"), 'verify:\n  - "exit 1"\n');

    // verify -> review: BLOCKED by failing scripts
    const r2 = await app.sessionHooks.mediateStageHandoff(session.id, {
      autoDispatch: false,
      source: "test",
    });
    expect(r2.ok).toBe(false);
    expect(r2.blockedByVerification).toBe(true);
    expect(r2.fromStage).toBe("verify");

    // Session stuck at verify, not review
    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    expect(updated?.status).toBe("blocked");
  });

  it("block -> fix -> advance lifecycle at verify stage", async () => {
    const dir = join(app.arkDir, `workdir-lifecycle-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".ark.yaml"), 'verify:\n  - "test -f VERIFIED.txt"\n');

    const session = await app.sessions.create({ summary: "lifecycle test", flow: "autonomous-sdlc" });
    await app.sessions.update(session.id, { status: "ready", stage: "verify", workdir: dir });

    // Step 1: Blocked (VERIFIED.txt doesn't exist)
    const r1 = await app.sessionHooks.mediateStageHandoff(session.id, {
      autoDispatch: false,
      source: "test",
    });
    expect(r1.ok).toBe(false);
    expect(r1.blockedByVerification).toBe(true);

    // Step 2: Fix (create the file)
    writeFileSync(join(dir, "VERIFIED.txt"), "quality gate passed");
    await app.sessions.update(session.id, { status: "ready", breakpoint_reason: null });

    // Step 3: Retry -- should advance
    const r2 = await app.sessionHooks.mediateStageHandoff(session.id, {
      autoDispatch: false,
      source: "test",
    });
    expect(r2.ok).toBe(true);
    expect(r2.toStage).toBe("review");
  });

  it("advances through full pipeline to completion", async () => {
    const session = await app.sessions.create({ summary: "full pipeline test", flow: "autonomous-sdlc" });
    await app.sessions.update(session.id, { status: "ready", stage: "plan" });

    const stageSequence = ["plan", "implement", "verify", "review", "pr"];

    for (let i = 0; i < stageSequence.length; i++) {
      const currentStage = stageSequence[i];
      expect((await app.sessions.get(session.id))?.stage).toBe(currentStage);

      const result = await app.sessionHooks.mediateStageHandoff(session.id, {
        autoDispatch: false,
        source: "test",
      });

      if (i < stageSequence.length - 1) {
        expect(result.ok).toBe(true);
        expect(result.toStage).toBe(stageSequence[i + 1]);
      } else {
        // Last stage: flow completes
        expect(result.ok).toBe(true);
        expect(result.flowCompleted).toBe(true);
      }
    }

    const final = await app.sessions.get(session.id);
    expect(final?.status).toBe("completed");
  });
});

// ── 6. Observability: events emitted correctly ─────────────────────────

describe("quality gate observability", async () => {
  it("emits stage_handoff_blocked event on verify failure", async () => {
    const workdir = createWorkdirWithVerify(["echo test-failed && exit 1"]);
    const session = await app.sessions.create({ summary: "qg event test", flow: "autonomous-sdlc" });
    await app.sessions.update(session.id, { status: "ready", stage: "verify", workdir });

    await app.sessionHooks.mediateStageHandoff(session.id, { source: "channel_report" });

    const events = await app.events.list(session.id);
    const blocked = events.find((e) => e.type === "stage_handoff_blocked");
    expect(blocked).toBeTruthy();
    expect(blocked!.data?.reason).toBe("verification_failed");
    expect(blocked!.data?.source).toBe("channel_report");
    expect(blocked!.stage).toBe("verify");
    expect(blocked!.data?.message).toContain("verify failed");
  });

  it("emits stage_handoff event on verify success", async () => {
    const workdir = createWorkdirWithVerify(["true"]);
    const session = await app.sessions.create({ summary: "qg handoff event", flow: "autonomous-sdlc" });
    await app.sessions.update(session.id, { status: "ready", stage: "verify", workdir });

    await app.sessionHooks.mediateStageHandoff(session.id, {
      autoDispatch: false,
      source: "channel_report",
    });

    const events = await app.events.list(session.id);
    const handoff = events.find((e) => e.type === "stage_handoff");
    expect(handoff).toBeTruthy();
    expect(handoff!.data?.from_stage).toBe("verify");
    expect(handoff!.data?.to_stage).toBe("review");
  });

  it("sends error message to session on verify failure", async () => {
    const workdir = createWorkdirWithVerify(["exit 1"]);
    const session = await app.sessions.create({ summary: "qg error msg test", flow: "autonomous-sdlc" });
    await app.sessions.update(session.id, { status: "ready", stage: "verify", workdir });

    await app.sessionHooks.mediateStageHandoff(session.id, { source: "test" });

    const msgs = await app.messages.list(session.id);
    const errorMsg = msgs.find((m) => m.content.includes("Advance blocked"));
    expect(errorMsg).toBeTruthy();
    expect(errorMsg!.content).toContain("verify");
  });
});

// ── 7. Comparison: autonomous flow (no verify stage) ───────────────────

describe("autonomous flow (single stage, no verify)", async () => {
  it("autonomous flow has no verify stage", () => {
    const stages = flow.getStages(app, "autonomous");
    const verifyStage = stages.find((s) => s.name === "verify");
    expect(verifyStage).toBeFalsy();
  });

  it("autonomous flow still respects repo config verify on work stage", async () => {
    const workdir = createWorkdirWithVerify(["exit 1"]);
    const session = await app.sessions.create({ summary: "autonomous verify test", flow: "autonomous" });
    await app.sessions.update(session.id, { status: "ready", stage: "work", workdir });

    const result = await app.sessionHooks.mediateStageHandoff(session.id, {
      autoDispatch: false,
      source: "test",
    });

    // Repo config verify scripts should still block handoff
    expect(result.ok).toBe(false);
    expect(result.blockedByVerification).toBe(true);
  });

  it("autonomous flow completes when repo config verify passes", async () => {
    const workdir = createWorkdirWithVerify(["true"]);
    const session = await app.sessions.create({ summary: "autonomous pass test", flow: "autonomous" });
    await app.sessions.update(session.id, { status: "ready", stage: "work", workdir });

    const result = await app.sessionHooks.mediateStageHandoff(session.id, {
      autoDispatch: false,
      source: "test",
    });

    expect(result.ok).toBe(true);
    expect(result.flowCompleted).toBe(true);
  });
});

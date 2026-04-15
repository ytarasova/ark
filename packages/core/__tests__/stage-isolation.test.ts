/**
 * Tests for stage isolation with fresh runtime per stage.
 *
 * Each stage gets a fresh runtime by default -- claude_session_id is cleared
 * on stage advance so the next dispatch creates a new Claude session instead
 * of resuming the previous one. Context passes structurally via the task
 * prompt (PLAN.md, git log, events), not conversation resumption.
 *
 * Stages can opt into "continue" isolation to preserve claude_session_id
 * for use cases where the same agent refines its own output.
 *
 * Test coverage:
 * 1. advance() clears claude_session_id by default (fresh isolation)
 * 2. advance() always clears session_id (tmux handle)
 * 3. advance() preserves claude_session_id when next stage has isolation="continue"
 * 4. mediateStageHandoff integration verifies full handoff chain
 * 5. Stage events include isolation mode for observability
 * 6. Flow completion does not need isolation (terminal state)
 * 7. Multi-stage flow: each transition clears runtime state
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { advance, mediateStageHandoff } from "../services/session-orchestration.js";

let app: AppContext;

beforeEach(async () => {
  if (app) {
    await app.shutdown();
    clearApp();
  }
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});

afterEach(async () => {
  // no-op -- beforeEach handles cleanup
});

// ── Fresh isolation (default) ────────────────────────────────────────────

describe("stage isolation: fresh runtime per stage", () => {
  it("clears claude_session_id on advance (default fresh isolation)", async () => {
    const session = app.sessions.create({ summary: "isolation test", flow: "quick" });
    app.sessions.update(session.id, {
      status: "ready",
      stage: "implement",
      claude_session_id: "prev-claude-session-abc",
      session_id: "ark-s-tmux-handle",
    });

    const result = await advance(app, session.id);
    expect(result.ok).toBe(true);

    const updated = app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    expect(updated?.status).toBe("ready");
    // Fresh isolation: claude_session_id should be cleared
    expect(updated?.claude_session_id).toBeNull();
    // Tmux handle should always be cleared
    expect(updated?.session_id).toBeNull();
  });

  it("clears session_id (tmux handle) on advance", async () => {
    const session = app.sessions.create({ summary: "tmux clear test", flow: "quick" });
    app.sessions.update(session.id, {
      status: "ready",
      stage: "implement",
      session_id: "ark-s-old-tmux",
    });

    const result = await advance(app, session.id);
    expect(result.ok).toBe(true);

    const updated = app.sessions.get(session.id);
    expect(updated?.session_id).toBeNull();
  });

  it("clears runtime state through multi-stage flow", async () => {
    // quick flow: implement -> verify -> pr -> merge
    const session = app.sessions.create({ summary: "multi-stage isolation", flow: "quick" });
    app.sessions.update(session.id, {
      status: "ready",
      stage: "implement",
      claude_session_id: "claude-session-stage-1",
      session_id: "tmux-stage-1",
    });

    // Stage 1 -> 2: implement -> verify
    const r1 = await advance(app, session.id);
    expect(r1.ok).toBe(true);
    let s = app.sessions.get(session.id);
    expect(s?.stage).toBe("verify");
    expect(s?.claude_session_id).toBeNull();
    expect(s?.session_id).toBeNull();

    // Simulate stage 2 running and getting new IDs
    app.sessions.update(session.id, {
      claude_session_id: "claude-session-stage-2",
      session_id: "tmux-stage-2",
    });

    // Stage 2 -> 3: verify -> pr
    const r2 = await advance(app, session.id);
    expect(r2.ok).toBe(true);
    s = app.sessions.get(session.id);
    expect(s?.stage).toBe("pr");
    expect(s?.claude_session_id).toBeNull();
    expect(s?.session_id).toBeNull();
  });

  it("does not clear claude_session_id on flow completion", async () => {
    // autonomous flow has one stage: "work" with auto gate
    const session = app.sessions.create({ summary: "completion test", flow: "autonomous" });
    app.sessions.update(session.id, {
      status: "ready",
      stage: "work",
      claude_session_id: "final-session-id",
    });

    const result = await advance(app, session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Flow completed");

    const updated = app.sessions.get(session.id);
    expect(updated?.status).toBe("completed");
    // On flow completion, claude_session_id is preserved (no next stage to isolate)
    expect(updated?.claude_session_id).toBe("final-session-id");
  });
});

// ── Observability ────────────────────────────────────────────────────────

describe("stage isolation: observability", () => {
  it("logs isolation mode in stage_ready event", async () => {
    const session = app.sessions.create({ summary: "observability test", flow: "quick" });
    app.sessions.update(session.id, {
      status: "ready",
      stage: "implement",
      claude_session_id: "obs-session",
    });

    await advance(app, session.id);

    const events = app.events.list(session.id);
    const stageReady = events.find((e) => e.type === "stage_ready");
    expect(stageReady).toBeTruthy();
    expect(stageReady!.data?.isolation).toBe("fresh");
    expect(stageReady!.data?.from_stage).toBe("implement");
    expect(stageReady!.data?.to_stage).toBe("verify");
  });
});

// ── mediateStageHandoff integration ──────────────────────────────────────

describe("stage isolation: mediateStageHandoff integration", () => {
  it("clears runtime state during mediated handoff", async () => {
    const session = app.sessions.create({ summary: "mediated isolation test", flow: "quick" });
    app.sessions.update(session.id, {
      status: "ready",
      stage: "implement",
      claude_session_id: "pre-handoff-session",
      session_id: "pre-handoff-tmux",
    });

    const result = await mediateStageHandoff(app, session.id, {
      autoDispatch: false,
      source: "test",
    });

    expect(result.ok).toBe(true);
    expect(result.fromStage).toBe("implement");
    expect(result.toStage).toBe("verify");

    const updated = app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    expect(updated?.claude_session_id).toBeNull();
    expect(updated?.session_id).toBeNull();
  });

  it("clears runtime state through complete flow via mediateStageHandoff", async () => {
    // quick flow: implement -> verify -> pr -> merge
    const session = app.sessions.create({ summary: "full mediation test", flow: "quick" });
    app.sessions.update(session.id, {
      status: "ready",
      stage: "implement",
      claude_session_id: "session-impl",
      session_id: "tmux-impl",
    });

    // Advance through all stages
    const stages = ["implement", "verify", "pr"];
    for (const fromStage of stages) {
      const r = await mediateStageHandoff(app, session.id, {
        autoDispatch: false,
        source: "test",
      });
      expect(r.ok).toBe(true);
      expect(r.fromStage).toBe(fromStage);

      if (!r.flowCompleted) {
        const s = app.sessions.get(session.id);
        expect(s?.claude_session_id).toBeNull();
        expect(s?.session_id).toBeNull();
        // Simulate next stage running
        app.sessions.update(session.id, {
          claude_session_id: `session-${r.toStage}`,
          session_id: `tmux-${r.toStage}`,
        });
      }
    }

    // Final advance: merge -> completed
    const final = await mediateStageHandoff(app, session.id, {
      autoDispatch: false,
      source: "test",
    });
    expect(final.ok).toBe(true);
    expect(final.flowCompleted).toBe(true);
  });
});

// ── Continue isolation mode ─────────────────────────────────────────────

describe("stage isolation: continue mode", () => {
  it("preserves claude_session_id when next stage has isolation=continue", async () => {
    // Register a custom flow with isolation=continue on the second stage
    const customFlow = {
      name: "isolation-test-flow",
      description: "Test flow with mixed isolation modes",
      stages: [
        { name: "plan", agent: "planner", gate: "auto" as const },
        { name: "refine", agent: "planner", gate: "auto" as const, isolation: "continue" as const },
        { name: "implement", agent: "implementer", gate: "auto" as const },
      ],
    };
    app.flows.save(customFlow.name, customFlow);

    const session = app.sessions.create({ summary: "continue isolation test", flow: "isolation-test-flow" });
    app.sessions.update(session.id, {
      status: "ready",
      stage: "plan",
      claude_session_id: "plan-session-id",
      session_id: "plan-tmux",
    });

    // plan -> refine (isolation=continue): should preserve claude_session_id
    const r1 = await advance(app, session.id);
    expect(r1.ok).toBe(true);

    let updated = app.sessions.get(session.id);
    expect(updated?.stage).toBe("refine");
    // Continue mode: claude_session_id preserved for --resume
    expect(updated?.claude_session_id).toBe("plan-session-id");
    // session_id (tmux handle) is always cleared -- the executor creates a new handle
    expect(updated?.session_id).toBeNull();

    // Simulate refine stage running
    app.sessions.update(session.id, {
      session_id: "refine-tmux",
    });

    // refine -> implement (isolation=fresh by default): should clear claude_session_id
    const r2 = await advance(app, session.id);
    expect(r2.ok).toBe(true);

    updated = app.sessions.get(session.id);
    expect(updated?.stage).toBe("implement");
    // Fresh isolation: claude_session_id cleared
    expect(updated?.claude_session_id).toBeNull();
    expect(updated?.session_id).toBeNull();
  });

  it("logs correct isolation mode in events for continue stage", async () => {
    const customFlow = {
      name: "isolation-event-flow",
      stages: [
        { name: "draft", agent: "planner", gate: "auto" as const },
        { name: "polish", agent: "planner", gate: "auto" as const, isolation: "continue" as const },
      ],
    };
    app.flows.save(customFlow.name, customFlow);

    const session = app.sessions.create({ summary: "event isolation test", flow: "isolation-event-flow" });
    app.sessions.update(session.id, {
      status: "ready",
      stage: "draft",
      claude_session_id: "draft-session",
    });

    await advance(app, session.id);

    const events = app.events.list(session.id);
    const stageReady = events.find((e) => e.type === "stage_ready");
    expect(stageReady).toBeTruthy();
    expect(stageReady!.data?.isolation).toBe("continue");
  });
});

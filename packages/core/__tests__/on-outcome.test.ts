/**
 * Tests for on_outcome routing in flow stage definitions.
 *
 * Verifies that:
 * - resolveNextStage routes to the correct stage based on outcome
 * - Falls back to linear next when outcome doesn't match
 * - Falls back to linear next when no outcome provided
 * - validateDAG catches invalid on_outcome target references
 * - applyReport captures outcome from completion reports
 * - advance() uses outcome for routing
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { getStage, getNextStage, resolveNextStage, validateDAG, type StageDefinition } from "../state/flow.js";
import { AppContext } from "../app.js";
import { applyReport, advance } from "../services/session-orchestration.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

/** Write a YAML flow definition to the user flows directory. */
function writeFlow(name: string, def: Record<string, unknown>): void {
  const dir = join(app.config.arkDir, "flows");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(def));
}

// ── resolveNextStage ─────────────────────────────────────────────────────────

describe("resolveNextStage", () => {
  it("routes to on_outcome target when outcome matches", () => {
    writeFlow("outcome-flow", {
      name: "outcome-flow",
      stages: [
        { name: "review", agent: "reviewer", gate: "auto", on_outcome: { approved: "deploy", rejected: "revise" } },
        { name: "revise", agent: "implementer", gate: "auto" },
        { name: "deploy", agent: "closer", gate: "auto" },
      ],
    });
    expect(resolveNextStage(app, "outcome-flow", "review", "approved")).toBe("deploy");
    expect(resolveNextStage(app, "outcome-flow", "review", "rejected")).toBe("revise");
  });

  it("falls back to linear next when outcome doesn't match any key", () => {
    writeFlow("outcome-fallback", {
      name: "outcome-fallback",
      stages: [
        { name: "check", agent: "checker", gate: "auto", on_outcome: { pass: "deploy" } },
        { name: "fix", agent: "fixer", gate: "auto" },
        { name: "deploy", agent: "deployer", gate: "auto" },
      ],
    });
    // "unknown_outcome" is not in on_outcome map -- falls back to linear next ("fix")
    expect(resolveNextStage(app, "outcome-fallback", "check", "unknown_outcome")).toBe("fix");
  });

  it("falls back to linear next when no outcome provided", () => {
    writeFlow("outcome-no-arg", {
      name: "outcome-no-arg",
      stages: [
        { name: "review", agent: "reviewer", gate: "auto", on_outcome: { approved: "deploy" } },
        { name: "revise", agent: "implementer", gate: "auto" },
        { name: "deploy", agent: "closer", gate: "auto" },
      ],
    });
    expect(resolveNextStage(app, "outcome-no-arg", "review")).toBe("revise");
    expect(resolveNextStage(app, "outcome-no-arg", "review", undefined)).toBe("revise");
  });

  it("falls back to linear next when stage has no on_outcome", () => {
    writeFlow("no-outcome", {
      name: "no-outcome",
      stages: [
        { name: "plan", agent: "planner", gate: "auto" },
        { name: "implement", agent: "implementer", gate: "auto" },
      ],
    });
    expect(resolveNextStage(app, "no-outcome", "plan")).toBe("implement");
    expect(resolveNextStage(app, "no-outcome", "plan", "some_outcome")).toBe("implement");
  });

  it("returns null at the last stage even with outcome", () => {
    writeFlow("outcome-last", {
      name: "outcome-last",
      stages: [{ name: "final", agent: "closer", gate: "auto", on_outcome: { done: "nonexistent" } }],
    });
    // "nonexistent" stage doesn't exist, falls back to linear -- which is null (last stage)
    expect(resolveNextStage(app, "outcome-last", "final", "done")).toBeNull();
  });

  it("falls back to linear if on_outcome target stage doesn't exist in flow", () => {
    writeFlow("outcome-bad-target", {
      name: "outcome-bad-target",
      stages: [
        { name: "check", agent: "checker", gate: "auto", on_outcome: { fail: "nonexistent" } },
        { name: "next", agent: "worker", gate: "auto" },
      ],
    });
    // Target "nonexistent" doesn't exist -- falls back to linear next ("next")
    expect(resolveNextStage(app, "outcome-bad-target", "check", "fail")).toBe("next");
  });

  it("handles empty string outcome (no routing)", () => {
    writeFlow("outcome-empty", {
      name: "outcome-empty",
      stages: [
        { name: "check", agent: "checker", gate: "auto", on_outcome: { pass: "deploy" } },
        { name: "fix", agent: "fixer", gate: "auto" },
        { name: "deploy", agent: "deployer", gate: "auto" },
      ],
    });
    expect(resolveNextStage(app, "outcome-empty", "check", "")).toBe("fix");
  });
});

// ── validateDAG with on_outcome ──────────────────────────────────────────────

describe("validateDAG with on_outcome", () => {
  it("passes when on_outcome targets reference valid stages", () => {
    const stages: StageDefinition[] = [
      { name: "review", agent: "reviewer", gate: "auto", on_outcome: { approved: "deploy", rejected: "revise" } },
      { name: "revise", agent: "implementer", gate: "auto" },
      { name: "deploy", agent: "deployer", gate: "auto" },
    ];
    expect(() => validateDAG(stages)).not.toThrow();
  });

  it("throws when on_outcome target references unknown stage", () => {
    const stages: StageDefinition[] = [
      { name: "review", agent: "reviewer", gate: "auto", on_outcome: { approved: "nonexistent" } },
      { name: "deploy", agent: "deployer", gate: "auto" },
    ];
    expect(() => validateDAG(stages)).toThrow("on_outcome 'approved' references unknown stage 'nonexistent'");
  });

  it("validates both depends_on and on_outcome together", () => {
    const stages: StageDefinition[] = [
      { name: "plan", agent: "planner", gate: "auto" },
      {
        name: "review",
        agent: "reviewer",
        gate: "auto",
        depends_on: ["plan"],
        on_outcome: { approved: "deploy", rejected: "plan" },
      },
      { name: "deploy", agent: "deployer", gate: "auto", depends_on: ["review"] },
    ];
    expect(() => validateDAG(stages)).not.toThrow();
  });

  it("catches unknown on_outcome target even when depends_on is valid", () => {
    const stages: StageDefinition[] = [
      { name: "plan", agent: "planner", gate: "auto" },
      { name: "review", agent: "reviewer", gate: "auto", depends_on: ["plan"], on_outcome: { fail: "ghost" } },
    ];
    expect(() => validateDAG(stages)).toThrow("on_outcome 'fail' references unknown stage 'ghost'");
  });
});

// ── applyReport outcome extraction ──────────────────────────────────────────

describe("applyReport outcome extraction", async () => {
  it("captures outcome from completed report", async () => {
    writeFlow("outcome-report-flow", {
      name: "outcome-report-flow",
      stages: [
        { name: "review", agent: "reviewer", gate: "auto", on_outcome: { approved: "deploy" } },
        { name: "deploy", agent: "deployer", gate: "auto" },
      ],
    });

    const session = await app.sessions.create({ summary: "Test outcome", flow: "outcome-report-flow" });
    await app.sessions.update(session.id, { status: "running", stage: "review", agent: "reviewer" });

    const result = await applyReport(app, session.id, {
      type: "completed",
      stage: "review",
      summary: "Review done",
      outcome: "approved",
    } as any);

    expect(result.outcome).toBe("approved");
  });

  it("does not set outcome when not provided in report", async () => {
    writeFlow("outcome-no-report", {
      name: "outcome-no-report",
      stages: [
        { name: "build", agent: "builder", gate: "auto" },
        { name: "test", agent: "tester", gate: "auto" },
      ],
    });

    const session = await app.sessions.create({ summary: "Test no outcome", flow: "outcome-no-report" });
    await app.sessions.update(session.id, { status: "running", stage: "build", agent: "builder" });

    const result = await applyReport(app, session.id, {
      type: "completed",
      stage: "build",
      summary: "Build done",
    } as any);

    expect(result.outcome).toBeUndefined();
  });
});

// ── advance() with outcome routing ──────────────────────────────────────────

describe("advance with outcome routing", async () => {
  it("advances to outcome-routed stage", async () => {
    writeFlow("outcome-advance", {
      name: "outcome-advance",
      stages: [
        { name: "review", agent: "reviewer", gate: "auto", on_outcome: { approved: "deploy", rejected: "revise" } },
        { name: "revise", agent: "implementer", gate: "auto" },
        { name: "deploy", agent: "closer", gate: "auto" },
      ],
    });

    const session = await app.sessions.create({ summary: "Test advance", flow: "outcome-advance" });
    await app.sessions.update(session.id, { status: "running", stage: "review", agent: "reviewer" });

    // Advance with outcome "approved" -- should go to "deploy" (skipping "revise")
    const result = await advance(app, session.id, true, "approved");
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Advanced to deploy");

    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).toBe("deploy");
  });

  it("advances to different outcome-routed stage", async () => {
    writeFlow("outcome-advance2", {
      name: "outcome-advance2",
      stages: [
        { name: "review", agent: "reviewer", gate: "auto", on_outcome: { approved: "deploy", rejected: "revise" } },
        { name: "revise", agent: "implementer", gate: "auto" },
        { name: "deploy", agent: "closer", gate: "auto" },
      ],
    });

    const session = await app.sessions.create({ summary: "Test advance rejected", flow: "outcome-advance2" });
    await app.sessions.update(session.id, { status: "running", stage: "review", agent: "reviewer" });

    // Advance with outcome "rejected" -- should go to "revise"
    const result = await advance(app, session.id, true, "rejected");
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Advanced to revise");

    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).toBe("revise");
  });

  it("falls back to linear advance when no outcome", async () => {
    writeFlow("outcome-advance-linear", {
      name: "outcome-advance-linear",
      stages: [
        { name: "review", agent: "reviewer", gate: "auto", on_outcome: { approved: "deploy" } },
        { name: "revise", agent: "implementer", gate: "auto" },
        { name: "deploy", agent: "closer", gate: "auto" },
      ],
    });

    const session = await app.sessions.create({ summary: "Test linear fallback", flow: "outcome-advance-linear" });
    await app.sessions.update(session.id, { status: "running", stage: "review", agent: "reviewer" });

    // Advance without outcome -- should go to linear next ("revise")
    const result = await advance(app, session.id, true);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Advanced to revise");

    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).toBe("revise");
  });
});

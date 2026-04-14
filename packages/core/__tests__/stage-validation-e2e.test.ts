/**
 * End-to-end tests for stage validation: verify scripts + todos.
 *
 * Validates the full lifecycle of stage validation gates:
 * 1. Verify scripts (from flow stage definition and repo config) execute and block/pass
 * 2. Todos block stage completion until resolved
 * 3. Both verify scripts AND todos must pass for handoff to succeed
 * 4. The complete() function respects verification (and --force bypasses it)
 * 5. Conductor HTTP path enforces verification blocking
 * 6. Observability events are emitted correctly on block/pass
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AppContext, setApp, clearApp } from "../app.js";
import {
  mediateStageHandoff,
  runVerification,
  complete,
} from "../services/session-orchestration.js";
import { startConductor } from "../conductor/conductor.js";

let app: AppContext;

beforeEach(async () => {
  if (app) { await app.shutdown(); clearApp(); }
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});

afterEach(async () => {
  // no-op -- beforeEach handles cleanup
});

// ── Helper: create a workdir with a .ark.yaml containing verify scripts ──

function createWorkdirWithVerifyScripts(
  scripts: string[],
  opts?: { extraYaml?: string },
): string {
  const dir = join(app.arkDir, `workdir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const yaml = [
    "verify:",
    ...scripts.map(s => `  - "${s}"`),
    opts?.extraYaml ?? "",
  ].join("\n");
  writeFileSync(join(dir, ".ark.yaml"), yaml);
  return dir;
}

// ── 1. Verify scripts from repo config ──────────────────────────────────

describe("verify scripts from repo config (.ark.yaml)", () => {
  it("passing verify scripts allow handoff", async () => {
    const workdir = createWorkdirWithVerifyScripts(["true"]);
    const session = app.sessions.create({ summary: "verify pass test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(true);
    expect(result.todosResolved).toBe(true);
    expect(result.scriptResults).toHaveLength(1);
    expect(result.scriptResults[0].passed).toBe(true);
    expect(result.message).toBe("Verification passed");
  });

  it("failing verify scripts block handoff", async () => {
    const workdir = createWorkdirWithVerifyScripts(["exit 1"]);
    const session = app.sessions.create({ summary: "verify fail test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(false);
    expect(result.scriptResults).toHaveLength(1);
    expect(result.scriptResults[0].passed).toBe(false);
    expect(result.message).toContain("verify failed");
  });

  it("partial script failures block even if some pass", async () => {
    const workdir = createWorkdirWithVerifyScripts(["true", "exit 1", "true"]);
    const session = app.sessions.create({ summary: "partial fail test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(false);
    expect(result.scriptResults).toHaveLength(3);
    expect(result.scriptResults[0].passed).toBe(true);
    expect(result.scriptResults[1].passed).toBe(false);
    expect(result.scriptResults[2].passed).toBe(true);
  });

  it("captures script output in results", async () => {
    const workdir = createWorkdirWithVerifyScripts(["echo hello-from-verify"]);
    const session = app.sessions.create({ summary: "output capture test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(true);
    expect(result.scriptResults[0].output).toContain("hello-from-verify");
  });

  it("captures stderr from failing scripts", async () => {
    const workdir = createWorkdirWithVerifyScripts(["echo error-output >&2 && exit 1"]);
    const session = app.sessions.create({ summary: "stderr capture test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(false);
    expect(result.scriptResults[0].output).toContain("error-output");
  });
});

// ── 2. Verify scripts from flow stage definition ────────────────────────

describe("verify scripts from flow stage definition", () => {
  it("default flow verify stage has verify scripts", () => {
    const stage = app.flows.get("default")?.stages.find(s => s.name === "verify");
    expect(stage).toBeTruthy();
    expect(stage!.verify).toBeDefined();
    expect(stage!.verify!.length).toBeGreaterThan(0);
  });

  it("stage verify scripts take precedence over repo config", async () => {
    // Create a workdir with repo config that has different verify scripts
    const workdir = createWorkdirWithVerifyScripts(["echo repo-config-script && exit 1"]);

    // Create a temporary flow with stage-level verify that passes
    const flowDir = join(app.arkDir, "flows");
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, "test-stage-verify.yaml"), [
      "name: test-stage-verify",
      "stages:",
      "  - name: work",
      "    agent: implementer",
      "    gate: auto",
      '    verify: ["true"]',
    ].join("\n"));

    const session = app.sessions.create({
      summary: "stage verify precedence test",
      flow: "test-stage-verify",
    });
    app.sessions.update(session.id, { status: "ready", stage: "work", workdir });

    const result = await runVerification(app, session.id);

    // Stage verify ("true") should take precedence over repo config ("exit 1")
    expect(result.ok).toBe(true);
    expect(result.scriptResults).toHaveLength(1);
    expect(result.scriptResults[0].script).toBe("true");
    expect(result.scriptResults[0].passed).toBe(true);
  });
});

// ── 3. Todo blocking ────────────────────────────────────────────────────

describe("todos block stage validation", () => {
  it("single unresolved todo blocks verification", async () => {
    const session = app.sessions.create({ summary: "todo block test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement" });
    app.todos.add(session.id, "Fix the failing test");

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(false);
    expect(result.todosResolved).toBe(false);
    expect(result.pendingTodos).toEqual(["Fix the failing test"]);
  });

  it("multiple unresolved todos all appear in message", async () => {
    const session = app.sessions.create({ summary: "multi-todo test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement" });
    app.todos.add(session.id, "Add error handling");
    app.todos.add(session.id, "Write unit tests");
    app.todos.add(session.id, "Update documentation");

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(false);
    expect(result.pendingTodos).toHaveLength(3);
    expect(result.message).toContain("Add error handling");
    expect(result.message).toContain("Write unit tests");
    expect(result.message).toContain("Update documentation");
    expect(result.message).toContain("3 unresolved todo");
  });

  it("resolved todos do not block verification", async () => {
    const session = app.sessions.create({ summary: "resolved todos test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement" });
    const t1 = app.todos.add(session.id, "Already done task");
    app.todos.toggle(t1.id);

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(true);
    expect(result.todosResolved).toBe(true);
    expect(result.pendingTodos).toHaveLength(0);
  });

  it("mix of resolved and unresolved todos: only unresolved block", async () => {
    const session = app.sessions.create({ summary: "mixed todos test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement" });
    const t1 = app.todos.add(session.id, "Done task");
    app.todos.toggle(t1.id);
    app.todos.add(session.id, "Still pending");

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(false);
    expect(result.pendingTodos).toEqual(["Still pending"]);
  });
});

// ── 4. Combined: todos AND verify scripts ───────────────────────────────

describe("combined todo + verify script validation", () => {
  it("both passing todos and scripts result in ok=true", async () => {
    const workdir = createWorkdirWithVerifyScripts(["true"]);
    const session = app.sessions.create({ summary: "both pass test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });
    const t = app.todos.add(session.id, "Completed task");
    app.todos.toggle(t.id);

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(true);
    expect(result.todosResolved).toBe(true);
    expect(result.scriptResults[0].passed).toBe(true);
  });

  it("passing scripts but pending todos: blocked", async () => {
    const workdir = createWorkdirWithVerifyScripts(["true"]);
    const session = app.sessions.create({ summary: "scripts pass todos fail", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });
    app.todos.add(session.id, "Not done yet");

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(false);
    expect(result.todosResolved).toBe(false);
    expect(result.scriptResults[0].passed).toBe(true);
    expect(result.message).toContain("unresolved todo");
  });

  it("failing scripts but resolved todos: blocked", async () => {
    const workdir = createWorkdirWithVerifyScripts(["exit 1"]);
    const session = app.sessions.create({ summary: "scripts fail todos pass", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });
    const t = app.todos.add(session.id, "All done");
    app.todos.toggle(t.id);

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(false);
    expect(result.todosResolved).toBe(true);
    expect(result.scriptResults[0].passed).toBe(false);
    expect(result.message).toContain("verify failed");
  });

  it("both failing: message includes both todo and script failures", async () => {
    const workdir = createWorkdirWithVerifyScripts(["echo lint-error && exit 1"]);
    const session = app.sessions.create({ summary: "both fail test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });
    app.todos.add(session.id, "Unfinished work");

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(false);
    expect(result.todosResolved).toBe(false);
    expect(result.scriptResults[0].passed).toBe(false);
    expect(result.message).toContain("unresolved todo");
    expect(result.message).toContain("verify failed");
  });
});

// ── 5. mediateStageHandoff with verify scripts ──────────────────────────

describe("mediateStageHandoff with verify scripts", () => {
  it("blocks handoff when repo config verify scripts fail", async () => {
    const workdir = createWorkdirWithVerifyScripts(["exit 1"]);
    const session = app.sessions.create({ summary: "handoff verify block", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });

    const result = await mediateStageHandoff(app, session.id, {
      autoDispatch: false,
      source: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.blockedByVerification).toBe(true);
    expect(result.fromStage).toBe("implement");

    const updated = app.sessions.get(session.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.breakpoint_reason).toContain("Verification failed");
  });

  it("allows handoff when repo config verify scripts pass", async () => {
    const workdir = createWorkdirWithVerifyScripts(["true"]);
    const session = app.sessions.create({ summary: "handoff verify pass", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });

    const result = await mediateStageHandoff(app, session.id, {
      autoDispatch: false,
      source: "test",
    });

    expect(result.ok).toBe(true);
    expect(result.toStage).toBe("verify");

    const updated = app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    expect(updated?.status).toBe("ready");
  });

  it("logs stage_handoff_blocked event with script failure details", async () => {
    const workdir = createWorkdirWithVerifyScripts(["echo test-failure-output && exit 1"]);
    const session = app.sessions.create({ summary: "blocked event test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });

    await mediateStageHandoff(app, session.id, { source: "channel_report" });

    const events = app.events.list(session.id);
    const blocked = events.find(e => e.type === "stage_handoff_blocked");
    expect(blocked).toBeTruthy();
    expect(blocked!.data?.reason).toBe("verification_failed");
    expect(blocked!.data?.source).toBe("channel_report");
    expect(blocked!.data?.message).toContain("verify failed");
    expect(blocked!.data?.message).toContain("test-failure-output");
  });

  it("sends error message to session when blocked", async () => {
    const workdir = createWorkdirWithVerifyScripts(["exit 1"]);
    const session = app.sessions.create({ summary: "error msg test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });

    await mediateStageHandoff(app, session.id, { source: "test" });

    const msgs = app.messages.list(session.id);
    const errorMsg = msgs.find(m => m.content.includes("Advance blocked"));
    expect(errorMsg).toBeTruthy();
    expect(errorMsg!.content).toContain("implement");
    expect(errorMsg!.content).toContain("verify failed");
  });

  it("blocks handoff with combined todo + script failures", async () => {
    const workdir = createWorkdirWithVerifyScripts(["exit 1"]);
    const session = app.sessions.create({ summary: "combined block test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });
    app.todos.add(session.id, "Incomplete task");

    const result = await mediateStageHandoff(app, session.id, {
      autoDispatch: false,
      source: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.blockedByVerification).toBe(true);

    const updated = app.sessions.get(session.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.breakpoint_reason).toContain("Verification failed");
  });
});

// ── 6. complete() function verification ─────────────────────────────────

describe("complete() with verification", () => {
  it("blocks completion when verify scripts fail", async () => {
    const workdir = createWorkdirWithVerifyScripts(["exit 1"]);
    const session = app.sessions.create({ summary: "complete block test", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement", workdir });

    const result = await complete(app, session.id);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Verification failed");

    // Session should NOT have advanced
    const updated = app.sessions.get(session.id);
    expect(updated?.stage).toBe("implement");
  });

  it("blocks completion when todos are pending", async () => {
    const session = app.sessions.create({ summary: "complete todo block", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });
    app.todos.add(session.id, "Must complete this first");

    const result = await complete(app, session.id);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("Verification failed");
    expect(result.message).toContain("unresolved todo");
  });

  it("force flag bypasses verification", async () => {
    const workdir = createWorkdirWithVerifyScripts(["exit 1"]);
    const session = app.sessions.create({ summary: "force complete test", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement", workdir });
    app.todos.add(session.id, "Pending todo");

    const result = await complete(app, session.id, { force: true });

    expect(result.ok).toBe(true);

    // Session should have advanced past implement
    const updated = app.sessions.get(session.id);
    expect(updated?.stage).not.toBe("implement");
  });

  it("allows completion when verification passes", async () => {
    const workdir = createWorkdirWithVerifyScripts(["true"]);
    const session = app.sessions.create({ summary: "complete pass test", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement", workdir });

    const result = await complete(app, session.id);

    expect(result.ok).toBe(true);

    // Session should have advanced
    const updated = app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
  });

  it("logs stage_completed event on success", async () => {
    const session = app.sessions.create({ summary: "complete event test", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });

    await complete(app, session.id);

    const events = app.events.list(session.id);
    const completed = events.find(e => e.type === "stage_completed");
    expect(completed).toBeTruthy();
    expect(completed!.data?.note).toBe("Manually completed");
  });
});

// ── 7. Full lifecycle: block -> fix -> advance ──────────────────────────

describe("full verification lifecycle", () => {
  it("todo lifecycle: add -> block -> resolve -> unblock -> advance", async () => {
    const session = app.sessions.create({ summary: "todo lifecycle test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement" });

    // Step 1: Add a todo -- should block
    const todo = app.todos.add(session.id, "Write tests for the feature");

    const r1 = await mediateStageHandoff(app, session.id, {
      autoDispatch: false,
      source: "test",
    });
    expect(r1.ok).toBe(false);
    expect(r1.blockedByVerification).toBe(true);
    expect(app.sessions.get(session.id)?.status).toBe("blocked");

    // Step 2: Resolve the todo
    app.todos.toggle(todo.id);
    expect(app.todos.allDone(session.id)).toBe(true);

    // Step 3: Reset status to ready (as the agent would after fixing)
    app.sessions.update(session.id, { status: "ready", breakpoint_reason: null });

    // Step 4: Retry handoff -- should succeed
    const r2 = await mediateStageHandoff(app, session.id, {
      autoDispatch: false,
      source: "test",
    });
    expect(r2.ok).toBe(true);
    expect(r2.toStage).toBe("verify");
    expect(app.sessions.get(session.id)?.status).toBe("ready");
  });

  it("script lifecycle: fail -> fix -> advance", async () => {
    // Create a workdir with a script that checks for a file
    const dir = join(app.arkDir, `workdir-script-lifecycle-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".ark.yaml"), 'verify:\n  - "test -f DONE.txt"\n');

    const session = app.sessions.create({ summary: "script lifecycle test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir: dir });

    // Step 1: Script fails (DONE.txt doesn't exist yet)
    const r1 = await mediateStageHandoff(app, session.id, {
      autoDispatch: false,
      source: "test",
    });
    expect(r1.ok).toBe(false);
    expect(r1.blockedByVerification).toBe(true);

    // Step 2: Fix the issue (create the file the script checks for)
    writeFileSync(join(dir, "DONE.txt"), "work completed");
    app.sessions.update(session.id, { status: "ready", breakpoint_reason: null });

    // Step 3: Retry handoff -- should succeed now
    const r2 = await mediateStageHandoff(app, session.id, {
      autoDispatch: false,
      source: "test",
    });
    expect(r2.ok).toBe(true);
    expect(r2.toStage).toBe("verify");
  });

  it("multi-stage advancement: verify at each stage", async () => {
    // Create a workdir with verify scripts that always pass
    const workdir = createWorkdirWithVerifyScripts(["true"]);
    const session = app.sessions.create({ summary: "multi-stage verify", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir });

    // implement -> verify
    const r1 = await mediateStageHandoff(app, session.id, {
      autoDispatch: false,
      source: "test",
    });
    expect(r1.ok).toBe(true);
    expect(r1.toStage).toBe("verify");

    // verify -> pr
    const r2 = await mediateStageHandoff(app, session.id, {
      autoDispatch: false,
      source: "test",
    });
    expect(r2.ok).toBe(true);
    expect(r2.toStage).toBe("pr");

    // Verify events were logged for each handoff
    const events = app.events.list(session.id);
    const handoffs = events.filter(e => e.type === "stage_handoff");
    expect(handoffs.length).toBeGreaterThanOrEqual(2);
  });
});

// ── 8. Conductor HTTP integration with verification ─────────────────────

const TEST_PORT = 19198;

describe("conductor HTTP integration with stage validation", () => {
  let server: { stop(): void } | null = null;

  afterEach(() => {
    if (server) { try { server.stop(); } catch { /* cleanup */ } server = null; }
  });

  it("channel report is blocked by unresolved todos via conductor", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const session = app.sessions.create({ summary: "conductor todo block", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });
    app.todos.add(session.id, "Must fix before advancing");

    const resp = await fetch(`http://localhost:${TEST_PORT}/api/channel/${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "completed",
        sessionId: session.id,
        stage: "implement",
        summary: "Implementation done",
        filesChanged: ["src/feature.ts"],
        commits: ["abc123"],
      }),
    });

    expect(resp.status).toBe(200);
    await new Promise(r => setTimeout(r, 150));

    const updated = app.sessions.get(session.id);
    expect(updated?.status).toBe("blocked");
    expect(updated?.breakpoint_reason).toContain("Verification failed");

    // Verify stage_handoff_blocked event
    const events = app.events.list(session.id);
    const blocked = events.find(e => e.type === "stage_handoff_blocked");
    expect(blocked).toBeTruthy();
  });

  it("channel report is blocked by failing verify scripts via conductor", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const workdir = createWorkdirWithVerifyScripts(["exit 1"]);
    const session = app.sessions.create({ summary: "conductor script block", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement", workdir });

    const resp = await fetch(`http://localhost:${TEST_PORT}/api/channel/${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "completed",
        sessionId: session.id,
        stage: "implement",
        summary: "Implementation done",
        filesChanged: [],
        commits: [],
      }),
    });

    expect(resp.status).toBe(200);
    await new Promise(r => setTimeout(r, 150));

    const updated = app.sessions.get(session.id);
    expect(updated?.status).toBe("blocked");
  });

  it("channel report advances when verification passes via conductor", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const workdir = createWorkdirWithVerifyScripts(["true"]);
    const session = app.sessions.create({ summary: "conductor verify pass", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement", workdir });

    const resp = await fetch(`http://localhost:${TEST_PORT}/api/channel/${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "completed",
        sessionId: session.id,
        stage: "implement",
        summary: "Implementation done",
        filesChanged: ["src/feature.ts"],
        commits: ["commit1"],
      }),
    });

    expect(resp.status).toBe(200);
    await new Promise(r => setTimeout(r, 150));

    const updated = app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    // Status is "ready" after advance, but background auto-dispatch may set it
    // to "running" if the executor succeeds -- either means handoff succeeded.
    expect(["ready", "running"]).toContain(updated?.status);
    expect(updated?.status).not.toBe("blocked");

    // Verify stage_handoff event (not blocked)
    const events = app.events.list(session.id);
    const handoff = events.find(e => e.type === "stage_handoff");
    expect(handoff).toBeTruthy();
    expect(handoff!.data?.from_stage).toBe("implement");
    expect(handoff!.data?.to_stage).toBe("verify");
  });

  it("todo resolve -> retry handoff succeeds via conductor", async () => {
    server = startConductor(app, TEST_PORT, { quiet: true });

    const session = app.sessions.create({ summary: "conductor todo resolve", flow: "quick" });
    app.sessions.update(session.id, { status: "running", stage: "implement" });
    const todo = app.todos.add(session.id, "Blocking todo");

    // First attempt: blocked by todo
    await fetch(`http://localhost:${TEST_PORT}/api/channel/${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "completed",
        sessionId: session.id,
        stage: "implement",
        summary: "Done",
        filesChanged: [],
        commits: [],
      }),
    });
    await new Promise(r => setTimeout(r, 150));
    expect(app.sessions.get(session.id)?.status).toBe("blocked");

    // Resolve the todo and reset status
    app.todos.toggle(todo.id);
    app.sessions.update(session.id, { status: "running", breakpoint_reason: null });

    // Second attempt: should advance
    await fetch(`http://localhost:${TEST_PORT}/api/channel/${session.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "completed",
        sessionId: session.id,
        stage: "implement",
        summary: "Done",
        filesChanged: [],
        commits: [],
      }),
    });
    await new Promise(r => setTimeout(r, 150));

    const updated = app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    // Status is "running" because auto-dispatch is now properly awaited
    expect(updated?.status).toBe("running");
  });
});

// ── 9. Edge cases ───────────────────────────────────────────────────────

describe("stage validation edge cases", () => {
  it("no verify scripts and no todos: verification passes trivially", async () => {
    const session = app.sessions.create({ summary: "no gates test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement" });

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(true);
    expect(result.scriptResults).toHaveLength(0);
    expect(result.pendingTodos).toHaveLength(0);
  });

  it("session with no workdir runs without scripts", async () => {
    const session = app.sessions.create({ summary: "no workdir test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement" });

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(true);
  });

  it("nonexistent session returns error from runVerification", async () => {
    const result = await runVerification(app, "s-does-not-exist");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("verify scripts run in session workdir context", async () => {
    const dir = join(app.arkDir, `workdir-context-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "marker.txt"), "found-it");
    writeFileSync(join(dir, ".ark.yaml"), 'verify:\n  - "cat marker.txt"\n');

    const session = app.sessions.create({ summary: "workdir context test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement", workdir: dir });

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(true);
    expect(result.scriptResults[0].output).toContain("found-it");
  });

  it("deleted todos do not block verification", async () => {
    const session = app.sessions.create({ summary: "deleted todo test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement" });
    const t = app.todos.add(session.id, "Will be deleted");
    app.todos.delete(t.id);

    const result = await runVerification(app, session.id);

    expect(result.ok).toBe(true);
    expect(result.todosResolved).toBe(true);
  });

  it("deleteForSession clears all todos, unblocking verification", async () => {
    const session = app.sessions.create({ summary: "clear todos test", flow: "quick" });
    app.sessions.update(session.id, { status: "ready", stage: "implement" });
    app.todos.add(session.id, "Task 1");
    app.todos.add(session.id, "Task 2");
    app.todos.add(session.id, "Task 3");

    // Before clearing: blocked
    expect((await runVerification(app, session.id)).ok).toBe(false);

    // Clear all
    app.todos.deleteForSession(session.id);

    // After clearing: passes
    expect((await runVerification(app, session.id)).ok).toBe(true);
  });
});

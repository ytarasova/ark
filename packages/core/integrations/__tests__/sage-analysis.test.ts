import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { pathToFileURL } from "url";

import { AppContext } from "../../app.js";
import { fetchAnalysis, buildStreamSubtasks, type SageAnalysis } from "../sage-analysis.js";
import { startSession } from "../../services/session-orchestration.js";
import { getStages } from "../../state/flow.js";
import { extractSubtasks } from "../../services/task-builder.js";

// ── Load the shipped sample.json once -- reused across describe blocks ──────

const SAMPLE_PATH = join(import.meta.dir, "..", "..", "..", "..", "examples", "from-sage-analysis", "sample.json");

async function loadSample(): Promise<SageAnalysis> {
  return JSON.parse(readFileSync(SAMPLE_PATH, "utf-8")) as SageAnalysis;
}

// ── fetchAnalysis: file:// round-trip ───────────────────────────────────────

describe("fetchAnalysis(file://)", () => {
  test("round-trips against the bundled sample", async () => {
    const analysis = await fetchAnalysis(pathToFileURL(SAMPLE_PATH).href, "IN-18342");
    expect(analysis.jira_id).toBe("IN-18342");
    expect(analysis.plan_streams).toHaveLength(3);
    expect(analysis.plan_streams[0].repo).toBe("pi-payouts-service");
    expect(analysis.plan_streams[0].tasks.length).toBeGreaterThan(0);
  });

  test("works when passed a direct filesystem path", async () => {
    const analysis = await fetchAnalysis(SAMPLE_PATH, "IN-18342");
    expect(analysis.plan_streams).toHaveLength(3);
  });

  test("throws a helpful error for missing files", async () => {
    await expect(fetchAnalysis("/tmp/does-not-exist.json", "X")).rejects.toThrow(/failed to read/);
  });

  test("extracts pi-sage's wrapped `raw` envelope", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sage-wrap-"));
    const p = join(tmp, "wrapped.json");
    writeFileSync(
      p,
      JSON.stringify({
        analysis: { id: 1, jira_id: "IN-7" },
        raw: {
          jira_id: "IN-7",
          summary: "wrapped",
          plan_streams: [{ repo: "alpha", tasks: [{ title: "t1" }] }],
        },
      }),
    );
    const analysis = await fetchAnalysis(pathToFileURL(p).href, "IN-7");
    expect(analysis.summary).toBe("wrapped");
    expect(analysis.plan_streams[0].repo).toBe("alpha");
    rmSync(tmp, { recursive: true, force: true });
  });
});

// ── buildStreamSubtasks: one subtask per plan_stream ────────────────────────

describe("buildStreamSubtasks", () => {
  test("emits one subtask per plan_stream, with ordered task blocks", async () => {
    const analysis = await loadSample();
    const subtasks = buildStreamSubtasks(analysis);

    expect(subtasks).toHaveLength(3);

    // Names are slugified + repo-prefixed for auditability.
    expect(subtasks[0].name).toContain("pi-payouts-service");
    expect(subtasks[1].name).toContain("pi-reconciler");
    expect(subtasks[2].name).toContain("pi-internal-sdk");

    // Prompt body includes the ticket summary + task titles in order.
    const first = subtasks[0].task;
    expect(first).toContain("IN-18342");
    expect(first).toContain("Onboard the new 'payouts-v2' ledger service");
    expect(first).toContain("### Task 1: Define PayoutFinalized v2 event schema");
    expect(first).toContain("### Task 2: Emit the event from the finalization path");
    expect(first).toContain("### Task 3: Expose v2 read endpoint");

    // Resolved gaps are rendered in the header so each stream sees decisions.
    expect(first).toContain("Resolved gaps");
    expect(first).toContain("soft-cutover");
  });
});

// ── Flow validator: from-sage-analysis.yaml loads with expected stages ──────

describe("from-sage-analysis flow", () => {
  let app: AppContext;

  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
  });

  afterAll(async () => {
    await app?.shutdown();
  });

  test("loads via the flow store with the expected stage shape", () => {
    const flow = app.flows.get("from-sage-analysis");
    expect(flow).not.toBeNull();
    expect(flow!.name).toBe("from-sage-analysis");

    const stages = getStages(app, "from-sage-analysis");
    expect(stages.map((s) => s.name)).toEqual(["fetch-analysis", "fan-out"]);

    // Stage 1 is an action call, stage 2 is a fan_out.
    expect(stages[0].action).toBe("fetch_sage_analysis");
    expect(stages[0].gate).toBe("auto");
    expect(stages[1].type).toBe("fan_out");
    expect(stages[1].gate).toBe("auto");
    expect(stages[1].depends_on).toEqual(["fetch-analysis"]);
  });

  test("extractSubtasks expands to one subtask per plan_stream when analysis_json is present", async () => {
    // Upload the sample analysis to the blob store under the session's
    // tenant (SessionRepository defaults to "default"). extractSubtasks
    // reads it back via the locator -- matches how `ark sage` seeds the
    // session in production.
    const bytes = readFileSync(SAMPLE_PATH);
    const meta = await app.blobStore.put(
      { tenantId: "default", namespace: "sage-analysis", id: "test-IN-18342", filename: "sample.json" },
      bytes,
    );

    const session = startSession(app, {
      summary: "sage:IN-18342",
      flow: "from-sage-analysis",
      inputs: {
        files: { analysis_json: meta.locator },
        params: { analysis_id: "IN-18342" },
      },
    });
    const sessionRecord = app.sessions.get(session.id)!;
    const subtasks = await extractSubtasks(app, sessionRecord);
    expect(subtasks).toHaveLength(3);
    // The first subtask prompt must contain the repo name + at least one task title.
    expect(subtasks[0].task).toContain("pi-payouts-service");
    expect(subtasks[0].task).toContain("PayoutFinalized");
  });

  test("extractSubtasks falls back to default when analysis_json is missing", async () => {
    const session = startSession(app, {
      summary: "no-analysis",
      flow: "from-sage-analysis",
    });
    const sessionRecord = app.sessions.get(session.id)!;
    const subtasks = await extractSubtasks(app, sessionRecord);
    // Default fallback returns implementation + tests
    expect(subtasks.length).toBeGreaterThan(0);
    expect(subtasks.some((s) => s.name === "implementation")).toBe(true);
  });
});

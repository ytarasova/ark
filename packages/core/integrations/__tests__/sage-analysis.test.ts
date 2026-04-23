import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { pathToFileURL } from "url";

import { fetchAnalysis, buildStreamSubtasks, type SageAnalysis } from "../sage-analysis.js";

// ── Load the shipped sample.json once -- reused across describe blocks ──────

const SAMPLE_PATH = join(import.meta.dir, "..", "..", "..", "..", "examples", "from-sage-analysis", "sample.json");

async function loadSample(): Promise<SageAnalysis> {
  return JSON.parse(readFileSync(SAMPLE_PATH, "utf-8")) as SageAnalysis;
}

// ── fetchAnalysis: file:// round-trip ───────────────────────────────────────

describe("fetchAnalysis(file://)", async () => {
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
    (await expect(fetchAnalysis("/tmp/does-not-exist.json", "X"))).rejects.toThrow(/failed to read/);
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

describe("buildStreamSubtasks", async () => {
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

// Note: from-sage-analysis.yaml was removed in P2.0b. The flow validator
// tests below were deleted along with the YAML. The fetchAnalysis and
// buildStreamSubtasks tests above cover the integration logic.

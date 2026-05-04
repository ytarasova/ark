/**
 * agent-sdk emits Stop / SessionEnd hooks with cost + usage attached
 * directly to the payload (no transcript file). The conductor's hook-status
 * pipeline must extract those values and persist them via
 * recordSessionUsage, otherwise the SessionSummary panel + Cost tab show
 * `$0.00` and `0 tokens` even though the cost is sitting in the event row.
 *
 * Pre-fix the recordSessionUsage branch was gated on `transcript_path`
 * (the claude-code shape) and ignored the agent-sdk shape entirely.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { startConductor } from "../conductor/conductor.js";
import { withTestContext, getApp } from "./test-helpers.js";

const TEST_PORT = 19199;

const { getCtx: _ } = withTestContext();
void _;

let server: { stop(): void };

beforeEach(() => {
  server = startConductor(getApp(), TEST_PORT, { quiet: true });
});

afterEach(() => {
  try {
    server.stop();
  } catch {
    /* cleanup */
  }
});

async function postHook(sessionId: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(`http://localhost:${TEST_PORT}/hooks/status?session=${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("agent-sdk Stop/SessionEnd cost recording", () => {
  it("Stop hook with embedded usage records cost ledger entries", async () => {
    const session = await getApp().sessions.create({ summary: "agent-sdk cost test" });
    await getApp().sessions.mergeConfig(session.id, { launch_executor: "claude-agent" });
    await getApp().sessions.update(session.id, { status: "running", session_id: `ark-s-${session.id}` });

    // Shape mirrors what messageToHooks produces from the SDK `result` line.
    const resp = await postHook(session.id, {
      hook_event_name: "Stop",
      session_id: "sdk-internal-id",
      total_cost_usd: 0.163,
      num_turns: 4,
      duration_ms: 14000,
      stop_reason: "end_turn",
      usage: {
        input_tokens: 5,
        output_tokens: 506,
        cache_creation_input_tokens: 33496,
        cache_read_input_tokens: 99365,
      },
    });
    expect(resp.status).toBe(200);

    // The cost endpoint should now return non-zero totals.
    const total = await getApp().usageRecorder.getSessionCost(session.id);
    // recordSessionUsage was called -> ledger has rows -> input + output > 0.
    expect(total.total_tokens).toBeGreaterThan(0);
    expect(total.input_tokens).toBe(5);
    expect(total.output_tokens).toBe(506);
    expect(total.cache_read_tokens).toBe(99365);
    expect(total.cache_write_tokens).toBe(33496);
  });

  it("Stop hook with no usage payload leaves the ledger untouched", async () => {
    const session = await getApp().sessions.create({ summary: "agent-sdk no-usage" });
    await getApp().sessions.mergeConfig(session.id, { launch_executor: "claude-agent" });
    await getApp().sessions.update(session.id, { status: "running", session_id: `ark-s-${session.id}` });

    await postHook(session.id, {
      hook_event_name: "Stop",
      total_cost_usd: 0,
    });

    const total = await getApp().usageRecorder.getSessionCost(session.id);
    expect(total.total_tokens).toBe(0);
  });

  it("SessionEnd does NOT double-record (Stop is canonical, SessionEnd is the transition hook)", async () => {
    // The launch script emits Stop + SessionEnd back-to-back with identical
    // usage payloads. Recording on both doubled every cost ledger entry.
    const session = await getApp().sessions.create({ summary: "no double record" });
    await getApp().sessions.mergeConfig(session.id, { launch_executor: "claude-agent" });
    await getApp().sessions.update(session.id, { status: "running", session_id: `ark-s-${session.id}` });

    await postHook(session.id, {
      hook_event_name: "Stop",
      total_cost_usd: 0.05,
      usage: { input_tokens: 100, output_tokens: 200 },
    });
    await postHook(session.id, {
      hook_event_name: "SessionEnd",
      total_cost_usd: 0.05,
      usage: { input_tokens: 100, output_tokens: 200 },
    });

    const total = await getApp().usageRecorder.getSessionCost(session.id);
    // Should be 300, not 600.
    expect(total.total_tokens).toBe(300);
    expect(total.records.length).toBe(1);
  });
});

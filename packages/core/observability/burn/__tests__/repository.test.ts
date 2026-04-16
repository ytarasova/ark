import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../../../app.js";

let app: AppContext;

beforeAll(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

describe("BurnRepository", () => {
  const testSessionId = "s-burn-test-001";
  const testTurns = [
    {
      session_id: testSessionId,
      tenant_id: "default",
      turn_index: 0,
      project: "ark",
      timestamp: "2026-04-15T10:00:00Z",
      user_message_preview: "Add a login feature",
      category: "coding",
      model: "claude-opus-4-6",
      provider: "anthropic",
      runtime: "claude-code",
      input_tokens: 50000,
      output_tokens: 10000,
      cache_read_tokens: 20000,
      cache_write_tokens: 5000,
      cost_usd: 1.25,
      api_calls: 2,
      has_edits: 1,
      retries: 0,
      is_one_shot: 1,
      tools_json: JSON.stringify(["Edit", "Bash"]),
      mcp_tools_json: JSON.stringify(["ark-channel"]),
      bash_cmds_json: JSON.stringify(["npm test"]),
      speed: "standard",
      transcript_mtime: 1713168000,
    },
    {
      session_id: testSessionId,
      tenant_id: "default",
      turn_index: 1,
      project: "ark",
      timestamp: "2026-04-15T10:05:00Z",
      user_message_preview: "Fix the failing test",
      category: "debugging",
      model: "claude-opus-4-6",
      provider: "anthropic",
      runtime: "claude-code",
      input_tokens: 30000,
      output_tokens: 8000,
      cache_read_tokens: 15000,
      cache_write_tokens: 3000,
      cost_usd: 0.85,
      api_calls: 1,
      has_edits: 1,
      retries: 2,
      is_one_shot: 0,
      tools_json: JSON.stringify(["Edit", "Bash", "Read"]),
      mcp_tools_json: JSON.stringify([]),
      bash_cmds_json: JSON.stringify(["pytest", "npm test"]),
      speed: "standard",
      transcript_mtime: 1713168000,
    },
    {
      session_id: testSessionId,
      tenant_id: "default",
      turn_index: 2,
      project: "ark",
      timestamp: "2026-04-15T10:10:00Z",
      user_message_preview: "Explain the architecture",
      category: "conversation",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      runtime: "claude-code",
      input_tokens: 10000,
      output_tokens: 5000,
      cache_read_tokens: 8000,
      cache_write_tokens: 0,
      cost_usd: 0.15,
      api_calls: 1,
      has_edits: 0,
      retries: 0,
      is_one_shot: 0,
      tools_json: JSON.stringify([]),
      mcp_tools_json: JSON.stringify([]),
      bash_cmds_json: JSON.stringify([]),
      speed: "standard",
      transcript_mtime: 1713168000,
    },
  ];

  it("upsertTurns inserts rows and getTurns retrieves them", () => {
    app.burn.upsertTurns(testSessionId, testTurns);
    const rows = app.burn.getTurns(testSessionId);

    expect(rows.length).toBe(3);
    expect(rows[0].session_id).toBe(testSessionId);
    expect(rows[0].turn_index).toBe(0);
    expect(rows[0].category).toBe("coding");
    expect(rows[0].model).toBe("claude-opus-4-6");
    expect(rows[0].input_tokens).toBe(50000);
    expect(rows[0].output_tokens).toBe(10000);
    expect(rows[0].cost_usd).toBeCloseTo(1.25, 2);
    expect(rows[0].has_edits).toBe(1);
    expect(rows[0].is_one_shot).toBe(1);

    expect(rows[1].turn_index).toBe(1);
    expect(rows[1].category).toBe("debugging");
    expect(rows[1].retries).toBe(2);

    expect(rows[2].turn_index).toBe(2);
    expect(rows[2].category).toBe("conversation");
    expect(rows[2].model).toBe("claude-sonnet-4-6");
  });

  it("getOverview returns aggregated data", () => {
    const overview = app.burn.getOverview({ tenantId: "default" });

    expect(overview.totalCostUsd).toBeCloseTo(1.25 + 0.85 + 0.15, 2);
    expect(overview.totalInputTokens).toBe(50000 + 30000 + 10000);
    expect(overview.totalOutputTokens).toBe(10000 + 8000 + 5000);
    expect(overview.totalCacheReadTokens).toBe(20000 + 15000 + 8000);
    expect(overview.totalCacheWriteTokens).toBe(5000 + 3000 + 0);
    expect(overview.totalApiCalls).toBe(2 + 1 + 1);
    expect(overview.totalSessions).toBe(1);
    expect(overview.cacheHitPct).toBeGreaterThan(0);
  });

  it("getCategoryBreakdown returns categories with oneShotPct", () => {
    const breakdown = app.burn.getCategoryBreakdown({ tenantId: "default" });

    expect(breakdown.length).toBeGreaterThanOrEqual(3);

    const coding = breakdown.find((r: any) => r.category === "coding");
    expect(coding).toBeDefined();
    expect(coding!.cost).toBeCloseTo(1.25, 2);
    expect(coding!.turns).toBe(1);
    // coding has 1 edit turn, 1 is_one_shot -> oneShotPct = 100
    expect(coding!.oneShotPct).toBe(100);

    const debugging = breakdown.find((r: any) => r.category === "debugging");
    expect(debugging).toBeDefined();
    // debugging has 1 edit turn, 0 is_one_shot -> oneShotPct = 0
    expect(debugging!.oneShotPct).toBe(0);

    const conversation = breakdown.find((r: any) => r.category === "conversation");
    expect(conversation).toBeDefined();
    // conversation has 0 edit turns -> oneShotPct = null
    expect(conversation!.oneShotPct).toBeNull();
  });

  it("getToolBreakdown aggregates from tools_json", () => {
    const tools = app.burn.getToolBreakdown({ tenantId: "default" });

    expect(tools.length).toBeGreaterThanOrEqual(1);

    // Edit appears in turn 0 and turn 1 -> 2 calls
    const editTool = tools.find((t: any) => t.tool === "Edit");
    expect(editTool).toBeDefined();
    expect(editTool!.calls).toBe(2);

    // Bash appears in turn 0 and turn 1 -> 2 calls
    const bashTool = tools.find((t: any) => t.tool === "Bash");
    expect(bashTool).toBeDefined();
    expect(bashTool!.calls).toBe(2);

    // Read appears only in turn 1 -> 1 call
    const readTool = tools.find((t: any) => t.tool === "Read");
    expect(readTool).toBeDefined();
    expect(readTool!.calls).toBe(1);
  });
});

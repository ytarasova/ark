import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../app.js";
import type { BurnTurnRow } from "../burn.js";

describe("BurnRepository.getDailyBreakdown tz bucketing", () => {
  let app: AppContext;
  beforeAll(async () => { app = AppContext.forTest(); await app.boot(); });
  afterAll(async () => { await app?.shutdown(); });

  beforeEach(() => {
    app.db.prepare("DELETE FROM burn_turns").run();
  });

  const baseRow = (ts: string, idx: number): BurnTurnRow => ({
    session_id: "s-tz-test",
    tenant_id: "default",
    turn_index: idx,
    project: null,
    timestamp: ts,
    user_message_preview: null,
    category: "coding",
    model: "claude-sonnet",
    provider: "anthropic",
    runtime: "claude",
    input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0,
    cost_usd: 1, api_calls: 1,
    has_edits: 0, retries: 0, is_one_shot: 0,
    tools_json: "[]", mcp_tools_json: "[]", bash_cmds_json: "[]",
    speed: "normal", transcript_mtime: null,
  });

  it("buckets 23:00 EDT April 15 under April 15 when tz=America/New_York", () => {
    app.burn.upsertTurns("s-tz-test", [baseRow("2026-04-16T03:00:00.000Z", 0)]);
    const rows = app.burn.getDailyBreakdown({
      tenantId: "default",
      since: "2026-04-10T00:00:00.000Z",
      until: "2026-04-20T00:00:00.000Z",
      tz: "America/New_York",
    });
    expect(rows.length).toBe(1);
    expect(rows[0].date).toBe("2026-04-15");
  });

  it("defaults to UTC bucketing when tz omitted", () => {
    app.burn.upsertTurns("s-tz-test", [baseRow("2026-04-16T03:00:00.000Z", 0)]);
    const rows = app.burn.getDailyBreakdown({
      tenantId: "default",
      since: "2026-04-10T00:00:00.000Z",
      until: "2026-04-20T00:00:00.000Z",
    });
    expect(rows[0].date).toBe("2026-04-16");
  });
});

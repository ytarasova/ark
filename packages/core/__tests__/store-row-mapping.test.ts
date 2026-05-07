/**
 * Tests for store row mapping functions: rowToSession field mapping,
 * JSON config parsing, and message read boolean conversion.
 *
 * Tests rowToCompute, rowToEvent, and rowToMessage indirectly through
 * public API since those functions are not exported.
 */

import { describe, it, expect } from "bun:test";
import { safeParseConfig } from "../util.js";
import type { SessionStatus, MessageRole, MessageType } from "../../types/index.js";

interface SessionRow {
  id: string;
  ticket: string | null;
  summary: string | null;
  repo: string | null;
  branch: string | null;
  compute_name: string | null;
  session_id: string | null;
  claude_session_id: string | null;
  stage: string | null;
  status: string;
  flow: string;
  agent: string | null;
  workdir: string | null;
  pr_url: string | null;
  pr_id: string | null;
  error: string | null;
  parent_id: string | null;
  fork_group: string | null;
  group_name: string | null;
  breakpoint_reason: string | null;
  attached_by: string | null;
  config: string;
  created_at: string;
  updated_at: string;
}

function rowToSession(row: SessionRow) {
  return { ...row, status: row.status as SessionStatus, config: safeParseConfig(row.config) };
}
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

// ── rowToSession (exported, direct tests) ───────────────────────────────────

describe("rowToSession", () => {
  it("reads ticket, summary, flow from row", () => {
    const row: SessionRow = {
      id: "s-abc123",
      ticket: "PROJ-42",
      summary: "Fix the widget",
      repo: null,
      branch: null,
      compute_name: null,
      session_id: null,
      claude_session_id: null,
      stage: null,
      status: "pending",
      flow: "default",
      agent: null,
      workdir: null,
      pr_url: null,
      pr_id: null,
      error: null,
      parent_id: null,
      fork_group: null,
      group_name: null,
      breakpoint_reason: null,
      attached_by: null,
      config: "{}",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };

    const session = rowToSession(row);
    expect(session.ticket).toBe("PROJ-42");
    expect(session.summary).toBe("Fix the widget");
    expect(session.flow).toBe("default");
  });

  it("reads summary from row", () => {
    const row = makeRow({ summary: "Build the thing" });
    const session = rowToSession(row);
    expect(session.summary).toBe("Build the thing");
  });

  it("reads flow from row", () => {
    const row = makeRow({ flow: "quick" });
    const session = rowToSession(row);
    expect(session.flow).toBe("quick");
  });

  it("parses config JSON string into object", () => {
    const row = makeRow({ config: '{"key":"value","nested":{"a":1}}' });
    const session = rowToSession(row);
    expect(session.config).toEqual({ key: "value", nested: { a: 1 } });
  });

  it("parses empty config to empty object", () => {
    const row = makeRow({ config: "{}" });
    const session = rowToSession(row);
    expect(session.config).toEqual({});
  });

  it("handles null config gracefully (defaults to {})", () => {
    const row = makeRow({ config: null as unknown as string });
    const session = rowToSession(row);
    expect(session.config).toEqual({});
  });

  it("preserves all other fields as-is", () => {
    const row = makeRow({
      id: "s-test99",
      status: "running",
      repo: "my-repo",
      branch: "feat/test",
      stage: "implement",
      agent: "implementer",
      error: "something broke",
    });
    const session = rowToSession(row);
    expect(session.id).toBe("s-test99");
    expect(session.status).toBe("running");
    expect(session.repo).toBe("my-repo");
    expect(session.branch).toBe("feat/test");
    expect(session.stage).toBe("implement");
    expect(session.agent).toBe("implementer");
    expect(session.error).toBe("something broke");
  });
});

// ── rowToSession via createSession/getSession (round-trip) ──────────────────

describe("rowToSession round-trip via DB", () => {
  it("createSession stores and retrieves with correct field mapping", async () => {
    const session = await getApp().sessions.create({
      ticket: "TICKET-1",
      summary: "My task",
      flow: "quick",
      config: { priority: "high" },
    });

    expect(session.ticket).toBe("TICKET-1");
    expect(session.summary).toBe("My task");
    expect(session.flow).toBe("quick");
    expect(session.config).toEqual({ priority: "high" });
  });

  it("getSession returns properly mapped fields", async () => {
    const created = await getApp().sessions.create({
      ticket: "TICKET-2",
      summary: "Another task",
      flow: "bare",
    });

    const fetched = await getApp().sessions.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.ticket).toBe("TICKET-2");
    expect(fetched!.summary).toBe("Another task");
    expect(fetched!.flow).toBe("bare");
  });

  it("updateSession with config merges and parses JSON", async () => {
    const session = await getApp().sessions.create({ summary: "cfg test" });
    await getApp().sessions.update(session.id, { config: { foo: "bar", count: 42 } });

    const updated = await getApp().sessions.get(session.id);
    expect(updated!.config).toEqual({ foo: "bar", count: 42 });
  });
});

// ── rowToCompute (via public API) ───────────────────────────────────────────

describe("rowToCompute via DB", () => {
  it("parses config JSON on getCompute", async () => {
    const compute = await getApp().computeService.create({
      name: "test-compute-1",
      compute: "local",
      isolation: "docker",
      config: { instanceType: "t3.large", region: "us-east-1" },
    });

    const fetched = await getApp().computes.get("test-compute-1");
    expect(fetched).not.toBeNull();
    expect(fetched!.config).toEqual({ instanceType: "t3.large", region: "us-east-1" });
    expect(typeof fetched!.config).toBe("object");
  });

  it("returns empty object for empty config", async () => {
    const compute = await getApp().computeService.create({
      name: "test-compute-2",
      compute: "local",
      isolation: "docker",
    });
    const fetched = await getApp().computes.get("test-compute-2");
    expect(fetched!.config).toEqual({});
  });

  it("updateCompute preserves config as parsed object", async () => {
    await getApp().computeService.create({
      name: "test-compute-3",
      compute: "local",
      isolation: "docker",
      config: { a: 1 },
    });
    await getApp().computes.update("test-compute-3", { config: { a: 1, b: 2 } });

    const fetched = await getApp().computes.get("test-compute-3");
    expect(fetched!.config).toEqual({ a: 1, b: 2 });
  });
});

// ── rowToEvent (via public API) ──────────────────────────────────────────────

describe("rowToEvent via DB", () => {
  it("parses data JSON on getEvents", async () => {
    const session = await getApp().sessions.create({ summary: "event test" });
    await getApp().events.log(session.id, "test_event", {
      stage: "plan",
      actor: "agent",
      data: { result: "success", items: [1, 2, 3] },
    });

    const events = await getApp().events.list(session.id, { type: "test_event" });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[events.length - 1];
    expect(ev.data).toEqual({ result: "success", items: [1, 2, 3] });
    expect(typeof ev.data).toBe("object");
  });

  it("returns null data when event has no data", async () => {
    const session = await getApp().sessions.create({ summary: "event no data" });
    await getApp().events.log(session.id, "bare_event");

    const events = await getApp().events.list(session.id, { type: "bare_event" });
    expect(events.length).toBe(1);
    expect(events[0].data).toBeNull();
  });

  it("preserves event metadata fields", async () => {
    const session = await getApp().sessions.create({ summary: "event meta" });
    await getApp().events.log(session.id, "meta_event", { stage: "review", actor: "reviewer" });

    const events = await getApp().events.list(session.id, { type: "meta_event" });
    expect(events[0].stage).toBe("review");
    expect(events[0].actor).toBe("reviewer");
    expect(events[0].track_id).toBe(session.id);
    expect(typeof events[0].id).toBe("number");
    expect(events[0].created_at).toBeTruthy();
  });
});

// ── rowToMessage (via public API) ────────────────────────────────────────────

describe("rowToMessage via DB", () => {
  it("converts read from 0/1 integer to boolean", async () => {
    const session = await getApp().sessions.create({ summary: "msg test" });
    const msg = await getApp().messages.send(session.id, "agent" as MessageRole, "hello");

    // Freshly created message should have read = false (stored as 0)
    expect(msg.read).toBe(false);
    expect(typeof msg.read).toBe("boolean");
  });

  it("read is true after marking messages read", async () => {
    const session = await getApp().sessions.create({ summary: "read test" });
    await getApp().messages.send(session.id, "agent" as MessageRole, "unread");

    await getApp().messages.markRead(session.id);

    const msgs = await getApp().messages.list(session.id);
    expect(msgs[0].read).toBe(true);
    expect(typeof msgs[0].read).toBe("boolean");
  });

  it("preserves message fields", async () => {
    const session = await getApp().sessions.create({ summary: "field test" });
    const msg = await getApp().messages.send(
      session.id,
      "user" as MessageRole,
      "test content",
      "progress" as MessageType,
    );

    expect(msg.session_id).toBe(session.id);
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("test content");
    expect(msg.type).toBe("progress");
    expect(typeof msg.id).toBe("number");
    expect(msg.created_at).toBeTruthy();
  });
});

// ── Helper ───────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "s-000000",
    ticket: null,
    summary: null,
    repo: null,
    branch: null,
    compute_name: null,
    session_id: null,
    claude_session_id: null,
    stage: null,
    status: "pending",
    flow: "default",
    agent: null,
    workdir: null,
    pr_url: null,
    pr_id: null,
    error: null,
    parent_id: null,
    fork_group: null,
    group_name: null,
    breakpoint_reason: null,
    attached_by: null,
    config: "{}",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

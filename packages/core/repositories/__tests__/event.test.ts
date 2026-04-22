import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database.js";
import { EventRepository } from "../event.js";
import { initSchema } from "../schema.js";

let db: DatabaseAdapter;
let repo: EventRepository;

beforeEach(async () => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  await initSchema(db);
  repo = new EventRepository(db);
});

describe("EventRepository", async () => {
  // -- log --------------------------------------------------------------

  it("log inserts an event", async () => {
    await repo.log("s-abc123", "session_created");
    const events = await repo.list("s-abc123");
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("session_created");
    expect(events[0].track_id).toBe("s-abc123");
    expect(events[0].created_at).toBeTruthy();
  });

  it("log stores optional stage and actor", async () => {
    await repo.log("s-abc123", "stage_start", { stage: "plan", actor: "conductor" });
    const events = await repo.list("s-abc123");
    expect(events[0].stage).toBe("plan");
    expect(events[0].actor).toBe("conductor");
  });

  it("log stores data as JSON", async () => {
    await repo.log("s-abc123", "info", { data: { foo: "bar", count: 42 } });
    const events = await repo.list("s-abc123");
    expect(events[0].data).toEqual({ foo: "bar", count: 42 });
  });

  it("log with no opts sets nulls", async () => {
    await repo.log("s-abc123", "ping");
    const events = await repo.list("s-abc123");
    expect(events[0].stage).toBeNull();
    expect(events[0].actor).toBeNull();
    expect(events[0].data).toBeNull();
  });

  // -- list -------------------------------------------------------------

  it("list returns events for specific track", async () => {
    await repo.log("s-aaa", "evt1");
    await repo.log("s-bbb", "evt2");
    await repo.log("s-aaa", "evt3");
    const events = await repo.list("s-aaa");
    expect(events.length).toBe(2);
    expect(events.every((e) => e.track_id === "s-aaa")).toBe(true);
  });

  it("list returns events in ASC order by id", async () => {
    await repo.log("s-aaa", "first");
    await repo.log("s-aaa", "second");
    await repo.log("s-aaa", "third");
    const events = await repo.list("s-aaa");
    expect(events[0].type).toBe("first");
    expect(events[2].type).toBe("third");
  });

  it("list filters by type", async () => {
    await repo.log("s-aaa", "stage_start");
    await repo.log("s-aaa", "stage_end");
    await repo.log("s-aaa", "stage_start");
    const starts = await repo.list("s-aaa", { type: "stage_start" });
    expect(starts.length).toBe(2);
    expect(starts.every((e) => e.type === "stage_start")).toBe(true);
  });

  it("list respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await repo.log("s-aaa", `evt-${i}`);
    }
    const limited = await repo.list("s-aaa", { limit: 3 });
    expect(limited.length).toBe(3);
  });

  it("list returns empty array for nonexistent track", async () => {
    expect((await repo.list("s-nope")).length).toBe(0);
  });

  it("list parses data from JSON", async () => {
    await repo.log("s-aaa", "with-data", { data: { nested: { key: "val" } } });
    const events = await repo.list("s-aaa");
    expect(events[0].data).toEqual({ nested: { key: "val" } });
  });

  // -- deleteForTrack --------------------------------------------------

  it("deleteForTrack removes all events for a track", async () => {
    await repo.log("s-aaa", "evt1");
    await repo.log("s-aaa", "evt2");
    await repo.log("s-bbb", "evt3");
    await repo.deleteForTrack("s-aaa");
    expect((await repo.list("s-aaa")).length).toBe(0);
    expect((await repo.list("s-bbb")).length).toBe(1);
  });

  it("deleteForTrack is no-op for nonexistent track", async () => {
    // Should not throw
    await repo.deleteForTrack("s-nope");
  });
});

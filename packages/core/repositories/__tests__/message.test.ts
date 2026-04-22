import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database.js";
import { MessageRepository } from "../message.js";
import { initSchema } from "../schema.js";

let db: DatabaseAdapter;
let repo: MessageRepository;

beforeEach(async () => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  await initSchema(db);
  repo = new MessageRepository(db);
});

describe("MessageRepository", async () => {
  // -- send -------------------------------------------------------------

  it("send creates a message with defaults", async () => {
    const m = await repo.send("s-abc123", "user", "Hello");
    expect(m.id).toBeGreaterThan(0);
    expect(m.session_id).toBe("s-abc123");
    expect(m.role).toBe("user");
    expect(m.content).toBe("Hello");
    expect(m.type).toBe("text");
    expect(m.read).toBe(false);
    expect(m.created_at).toBeTruthy();
  });

  it("send with custom type", async () => {
    const m = await repo.send("s-abc123", "agent", "Working on it...", "progress");
    expect(m.type).toBe("progress");
  });

  it("send stores different roles", async () => {
    await repo.send("s-abc123", "user", "question");
    await repo.send("s-abc123", "agent", "answer");
    await repo.send("s-abc123", "system", "notification");
    const messages = await repo.list("s-abc123");
    expect(messages.map((m) => m.role)).toEqual(["user", "agent", "system"]);
  });

  // -- list -------------------------------------------------------------

  it("list returns messages for specific session", async () => {
    await repo.send("s-aaa", "user", "msg1");
    await repo.send("s-bbb", "user", "msg2");
    await repo.send("s-aaa", "agent", "msg3");
    const messages = await repo.list("s-aaa");
    expect(messages.length).toBe(2);
    expect(messages.every((m) => m.session_id === "s-aaa")).toBe(true);
  });

  it("list returns messages in ASC order", async () => {
    await repo.send("s-aaa", "user", "first");
    await repo.send("s-aaa", "agent", "second");
    await repo.send("s-aaa", "user", "third");
    const messages = await repo.list("s-aaa");
    expect(messages[0].content).toBe("first");
    expect(messages[2].content).toBe("third");
  });

  it("list respects limit", async () => {
    for (let i = 0; i < 10; i++) {
      await repo.send("s-aaa", "user", `msg-${i}`);
    }
    const limited = await repo.list("s-aaa", { limit: 3 });
    expect(limited.length).toBe(3);
    // Should return the 3 most recent (DESC limit then reversed)
    expect(limited[0].content).toBe("msg-7");
    expect(limited[2].content).toBe("msg-9");
  });

  it("list unreadOnly filters to unread messages", async () => {
    await repo.send("s-aaa", "user", "msg1");
    await repo.send("s-aaa", "agent", "msg2");
    await repo.markRead("s-aaa");
    await repo.send("s-aaa", "agent", "msg3"); // new unread
    const unread = await repo.list("s-aaa", { unreadOnly: true });
    expect(unread.length).toBe(1);
    expect(unread[0].content).toBe("msg3");
  });

  it("list returns empty for nonexistent session", async () => {
    expect((await repo.list("s-nope")).length).toBe(0);
  });

  // -- markRead ---------------------------------------------------------

  it("markRead marks all unread messages as read", async () => {
    await repo.send("s-aaa", "agent", "msg1");
    await repo.send("s-aaa", "agent", "msg2");
    await repo.markRead("s-aaa");
    const messages = await repo.list("s-aaa");
    expect(messages.every((m) => m.read === true)).toBe(true);
  });

  it("markRead is idempotent", async () => {
    await repo.send("s-aaa", "agent", "msg1");
    await repo.markRead("s-aaa");
    await repo.markRead("s-aaa"); // should not throw
    expect(await repo.unreadCount("s-aaa")).toBe(0);
  });

  it("markRead only affects specified session", async () => {
    await repo.send("s-aaa", "agent", "msg1");
    await repo.send("s-bbb", "agent", "msg2");
    await repo.markRead("s-aaa");
    expect(await repo.unreadCount("s-aaa")).toBe(0);
    expect(await repo.unreadCount("s-bbb")).toBe(1);
  });

  // -- unreadCount ------------------------------------------------------

  it("unreadCount counts only unread agent messages", async () => {
    await repo.send("s-aaa", "user", "from user");
    await repo.send("s-aaa", "agent", "from agent 1");
    await repo.send("s-aaa", "agent", "from agent 2");
    await repo.send("s-aaa", "system", "system msg");
    expect(await repo.unreadCount("s-aaa")).toBe(2); // only agent messages
  });

  it("unreadCount returns 0 after markRead", async () => {
    await repo.send("s-aaa", "agent", "msg1");
    await repo.send("s-aaa", "agent", "msg2");
    await repo.markRead("s-aaa");
    expect(await repo.unreadCount("s-aaa")).toBe(0);
  });

  it("unreadCount returns 0 for nonexistent session", async () => {
    expect(await repo.unreadCount("s-nope")).toBe(0);
  });

  // -- read field round-trip --------------------------------------------

  it("read field is boolean not integer", async () => {
    const m = await repo.send("s-aaa", "agent", "test");
    expect(typeof m.read).toBe("boolean");
    expect(m.read).toBe(false);
    await repo.markRead("s-aaa");
    const messages = await repo.list("s-aaa");
    expect(typeof messages[0].read).toBe("boolean");
    expect(messages[0].read).toBe(true);
  });
});

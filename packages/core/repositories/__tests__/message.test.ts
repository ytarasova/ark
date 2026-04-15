import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { IDatabase } from "../../database.js";
import { MessageRepository } from "../message.js";
import { initSchema } from "../schema.js";

let db: IDatabase;
let repo: MessageRepository;

beforeEach(() => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  initSchema(db);
  repo = new MessageRepository(db);
});

describe("MessageRepository", () => {
  // ── send ────────────────────────────────────────────────────────────────

  it("send creates a message with defaults", () => {
    const m = repo.send("s-abc123", "user", "Hello");
    expect(m.id).toBeGreaterThan(0);
    expect(m.session_id).toBe("s-abc123");
    expect(m.role).toBe("user");
    expect(m.content).toBe("Hello");
    expect(m.type).toBe("text");
    expect(m.read).toBe(false);
    expect(m.created_at).toBeTruthy();
  });

  it("send with custom type", () => {
    const m = repo.send("s-abc123", "agent", "Working on it...", "progress");
    expect(m.type).toBe("progress");
  });

  it("send stores different roles", () => {
    repo.send("s-abc123", "user", "question");
    repo.send("s-abc123", "agent", "answer");
    repo.send("s-abc123", "system", "notification");
    const messages = repo.list("s-abc123");
    expect(messages.map((m) => m.role)).toEqual(["user", "agent", "system"]);
  });

  // ── list ────────────────────────────────────────────────────────────────

  it("list returns messages for specific session", () => {
    repo.send("s-aaa", "user", "msg1");
    repo.send("s-bbb", "user", "msg2");
    repo.send("s-aaa", "agent", "msg3");
    const messages = repo.list("s-aaa");
    expect(messages.length).toBe(2);
    expect(messages.every((m) => m.session_id === "s-aaa")).toBe(true);
  });

  it("list returns messages in ASC order", () => {
    repo.send("s-aaa", "user", "first");
    repo.send("s-aaa", "agent", "second");
    repo.send("s-aaa", "user", "third");
    const messages = repo.list("s-aaa");
    expect(messages[0].content).toBe("first");
    expect(messages[2].content).toBe("third");
  });

  it("list respects limit", () => {
    for (let i = 0; i < 10; i++) {
      repo.send("s-aaa", "user", `msg-${i}`);
    }
    const limited = repo.list("s-aaa", { limit: 3 });
    expect(limited.length).toBe(3);
    // Should return the 3 most recent (DESC limit then reversed)
    expect(limited[0].content).toBe("msg-7");
    expect(limited[2].content).toBe("msg-9");
  });

  it("list unreadOnly filters to unread messages", () => {
    repo.send("s-aaa", "user", "msg1");
    repo.send("s-aaa", "agent", "msg2");
    repo.markRead("s-aaa");
    repo.send("s-aaa", "agent", "msg3"); // new unread
    const unread = repo.list("s-aaa", { unreadOnly: true });
    expect(unread.length).toBe(1);
    expect(unread[0].content).toBe("msg3");
  });

  it("list returns empty for nonexistent session", () => {
    expect(repo.list("s-nope").length).toBe(0);
  });

  // ── markRead ────────────────────────────────────────────────────────────

  it("markRead marks all unread messages as read", () => {
    repo.send("s-aaa", "agent", "msg1");
    repo.send("s-aaa", "agent", "msg2");
    repo.markRead("s-aaa");
    const messages = repo.list("s-aaa");
    expect(messages.every((m) => m.read === true)).toBe(true);
  });

  it("markRead is idempotent", () => {
    repo.send("s-aaa", "agent", "msg1");
    repo.markRead("s-aaa");
    repo.markRead("s-aaa"); // should not throw
    expect(repo.unreadCount("s-aaa")).toBe(0);
  });

  it("markRead only affects specified session", () => {
    repo.send("s-aaa", "agent", "msg1");
    repo.send("s-bbb", "agent", "msg2");
    repo.markRead("s-aaa");
    expect(repo.unreadCount("s-aaa")).toBe(0);
    expect(repo.unreadCount("s-bbb")).toBe(1);
  });

  // ── unreadCount ─────────────────────────────────────────────────────────

  it("unreadCount counts only unread agent messages", () => {
    repo.send("s-aaa", "user", "from user");
    repo.send("s-aaa", "agent", "from agent 1");
    repo.send("s-aaa", "agent", "from agent 2");
    repo.send("s-aaa", "system", "system msg");
    expect(repo.unreadCount("s-aaa")).toBe(2); // only agent messages
  });

  it("unreadCount returns 0 after markRead", () => {
    repo.send("s-aaa", "agent", "msg1");
    repo.send("s-aaa", "agent", "msg2");
    repo.markRead("s-aaa");
    expect(repo.unreadCount("s-aaa")).toBe(0);
  });

  it("unreadCount returns 0 for nonexistent session", () => {
    expect(repo.unreadCount("s-nope")).toBe(0);
  });

  // ── read field round-trip ───────────────────────────────────────────────

  it("read field is boolean not integer", () => {
    const m = repo.send("s-aaa", "agent", "test");
    expect(typeof m.read).toBe("boolean");
    expect(m.read).toBe(false);
    repo.markRead("s-aaa");
    const messages = repo.list("s-aaa");
    expect(typeof messages[0].read).toBe("boolean");
    expect(messages[0].read).toBe(true);
  });
});

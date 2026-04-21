/**
 * Tests for multi-tenant data isolation.
 *
 * Verifies that repositories scoped to different tenants cannot see
 * each other's data, and that the default tenant works for backward compat.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { AppContext } from "../app.js";

let app: AppContext;

beforeEach(async () => {
  if (app) {
    await app.shutdown();
  }
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  if (app) {
    await app.shutdown();
  }
});

describe("tenant scoping", async () => {
  describe("sessions", async () => {
    it("default tenant sees its own sessions", async () => {
      const session = await app.sessions.create({ summary: "default tenant session" });
      const found = await app.sessions.get(session.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(session.id);
    });

    it("scoped tenant cannot see default tenant sessions", async () => {
      const session = await app.sessions.create({ summary: "default only" });

      const scopedApp = app.forTenant("other-tenant");
      const found = scopedApp.sessions.get(session.id);
      expect(found).toBeNull();
    });

    it("different tenants have isolated session lists", async () => {
      // Create sessions in default tenant
      await app.sessions.create({ summary: "default 1" });
      await app.sessions.create({ summary: "default 2" });

      // Create sessions in tenant A
      const tenantA = app.forTenant("tenant-a");
      tenantA.sessions.create({ summary: "tenant A 1" });

      // Create sessions in tenant B
      const tenantB = app.forTenant("tenant-b");
      tenantB.sessions.create({ summary: "tenant B 1" });
      tenantB.sessions.create({ summary: "tenant B 2" });
      tenantB.sessions.create({ summary: "tenant B 3" });

      // Each tenant only sees its own sessions
      expect((await app.sessions.list()).length).toBe(2);
      expect(tenantA.sessions.list().length).toBe(1);
      expect(tenantB.sessions.list().length).toBe(3);
    });

    it("scoped tenant can create and retrieve sessions", () => {
      const scoped = app.forTenant("my-tenant");
      const session = scoped.sessions.create({ summary: "scoped session" });

      expect(session.id).toMatch(/^s-/);
      const found = scoped.sessions.get(session.id);
      expect(found).not.toBeNull();
      expect(found!.summary).toBe("scoped session");
    });

    it("scoped tenant can update its own sessions", () => {
      const scoped = app.forTenant("my-tenant");
      const session = scoped.sessions.create({ summary: "before update" });

      scoped.sessions.update(session.id, { summary: "after update" });
      const updated = scoped.sessions.get(session.id);
      expect(updated!.summary).toBe("after update");
    });

    it("scoped tenant cannot update another tenant's sessions", async () => {
      const session = await app.sessions.create({ summary: "default tenant" });

      const scoped = app.forTenant("other");
      const result = scoped.sessions.update(session.id, { summary: "hijacked" });
      expect(result).toBeNull();

      // Original should be unchanged
      const original = await app.sessions.get(session.id);
      expect(original!.summary).toBe("default tenant");
    });

    it("scoped tenant can delete its own sessions", () => {
      const scoped = app.forTenant("delete-tenant");
      const session = scoped.sessions.create({ summary: "to delete" });

      const ok = scoped.sessions.delete(session.id);
      expect(ok).toBe(true);
      expect(scoped.sessions.get(session.id)).toBeNull();
    });

    it("scoped tenant cannot delete another tenant's sessions", async () => {
      const session = await app.sessions.create({ summary: "protected" });

      const scoped = app.forTenant("other");
      const ok = scoped.sessions.delete(session.id);
      expect(ok).toBe(false);

      // Original should still exist
      expect(await app.sessions.get(session.id)).not.toBeNull();
    });

    it("claim is tenant-scoped", () => {
      const scoped = app.forTenant("claim-tenant");
      const session = scoped.sessions.create({ summary: "claim test" });

      // Claim from same tenant should work
      const ok = scoped.sessions.claim(session.id, "pending", "running");
      expect(ok).toBe(true);

      // Claim from different tenant should fail
      const other = app.forTenant("other");
      const otherOk = other.sessions.claim(session.id, "running", "completed");
      expect(otherOk).toBe(false);
    });

    it("search is tenant-scoped", async () => {
      await app.sessions.create({ summary: "searchable default" });
      const scoped = app.forTenant("search-tenant");
      scoped.sessions.create({ summary: "searchable scoped" });

      const defaultResults = app.sessions.search("searchable");
      expect(defaultResults.length).toBe(1);
      expect(defaultResults[0].summary).toBe("searchable default");

      const scopedResults = scoped.sessions.search("searchable");
      expect(scopedResults.length).toBe(1);
      expect(scopedResults[0].summary).toBe("searchable scoped");
    });
  });

  describe("events", () => {
    it("events are tenant-scoped", () => {
      const scoped = app.forTenant("event-tenant");
      const session = scoped.sessions.create({ summary: "event test" });

      scoped.events.log(session.id, "test_event", { data: { foo: "bar" } });

      // Same tenant can see the event
      const events = scoped.events.list(session.id);
      expect(events.length).toBe(1);
      expect(events[0].type).toBe("test_event");

      // Different tenant cannot see the event
      const other = app.forTenant("other");
      const otherEvents = other.events.list(session.id);
      expect(otherEvents.length).toBe(0);
    });
  });

  describe("messages", () => {
    it("messages are tenant-scoped", () => {
      const scoped = app.forTenant("msg-tenant");
      const session = scoped.sessions.create({ summary: "msg test" });

      scoped.messages.send(session.id, "user", "hello");

      // Same tenant can see messages
      const msgs = scoped.messages.list(session.id);
      expect(msgs.length).toBe(1);
      expect(msgs[0].content).toBe("hello");

      // Different tenant cannot
      const other = app.forTenant("other");
      const otherMsgs = other.messages.list(session.id);
      expect(otherMsgs.length).toBe(0);
    });

    it("unread count is tenant-scoped", () => {
      const scoped = app.forTenant("unread-tenant");
      const session = scoped.sessions.create({ summary: "unread test" });

      scoped.messages.send(session.id, "agent", "response");

      expect(scoped.messages.unreadCount(session.id)).toBe(1);

      const other = app.forTenant("other");
      expect(other.messages.unreadCount(session.id)).toBe(0);
    });
  });

  describe("todos", () => {
    it("todos are tenant-scoped", () => {
      const scoped = app.forTenant("todo-tenant");
      const session = scoped.sessions.create({ summary: "todo test" });

      scoped.todos.add(session.id, "fix the bug");

      // Same tenant can see todos
      const todos = scoped.todos.list(session.id);
      expect(todos.length).toBe(1);
      expect(todos[0].content).toBe("fix the bug");

      // Different tenant cannot
      const other = app.forTenant("other");
      const otherTodos = other.todos.list(session.id);
      expect(otherTodos.length).toBe(0);
    });

    it("allDone is tenant-scoped", () => {
      const scoped = app.forTenant("done-tenant");
      const session = scoped.sessions.create({ summary: "done test" });

      scoped.todos.add(session.id, "task");
      expect(scoped.todos.allDone(session.id)).toBe(false);

      // Different tenant has no todos, so allDone should be true
      const other = app.forTenant("other");
      expect(other.todos.allDone(session.id)).toBe(true);
    });
  });

  describe("compute", async () => {
    it("compute records are tenant-scoped", () => {
      const scoped = app.forTenant("compute-tenant");
      scoped.computes.create({ name: "my-compute" });

      // Same tenant sees it
      const found = scoped.computes.get("my-compute");
      expect(found).not.toBeNull();
      expect(found!.name).toBe("my-compute");

      // Different tenant does not
      const other = app.forTenant("other");
      const otherFound = other.computes.get("my-compute");
      expect(otherFound).toBeNull();
    });

    it("compute list is tenant-scoped", async () => {
      // Default tenant already has "local" compute from seed
      const defaultComputes = await app.computes.list();
      const defaultCount = defaultComputes.length;

      const scoped = app.forTenant("list-compute-tenant");
      scoped.computes.create({ name: "tenant-compute" });

      expect(scoped.computes.list().length).toBe(1);
      expect((await app.computes.list()).length).toBe(defaultCount);
    });
  });

  describe("forTenant", () => {
    it("shares the same database", () => {
      const scoped = app.forTenant("shared-db");
      // Both use the same underlying database
      expect(scoped.config.dbPath).toBe(app.config.dbPath);
    });

    it("preserves config", () => {
      const scoped = app.forTenant("config-check");
      expect(scoped.config.arkDir).toBe(app.config.arkDir);
      expect(scoped.config.conductorPort).toBe(app.config.conductorPort);
    });

    it("multiple forTenant calls create independent scopes", () => {
      const a = app.forTenant("a");
      const b = app.forTenant("b");

      a.sessions.create({ summary: "from A" });
      b.sessions.create({ summary: "from B" });

      expect(a.sessions.list().length).toBe(1);
      expect(b.sessions.list().length).toBe(1);
      expect(a.sessions.list()[0].summary).toBe("from A");
      expect(b.sessions.list()[0].summary).toBe("from B");
    });
  });

  describe("backward compatibility", async () => {
    it("default tenant works without explicit scoping", async () => {
      const session = await app.sessions.create({ summary: "no scoping needed" });
      expect(session).not.toBeNull();

      const found = await app.sessions.get(session.id);
      expect(found).not.toBeNull();

      const list = await app.sessions.list();
      expect(list.length).toBeGreaterThan(0);
    });

    it("setTenant/getTenant work on repositories", () => {
      expect(app.sessions.getTenant()).toBe("default");

      app.sessions.setTenant("custom");
      expect(app.sessions.getTenant()).toBe("custom");

      // Reset back for other tests
      app.sessions.setTenant("default");
    });
  });
});

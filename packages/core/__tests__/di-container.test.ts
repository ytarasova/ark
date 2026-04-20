/**
 * Integration tests for the awilix DI container wiring.
 *
 * Verifies that AppContext.boot() registers all dependencies in the container,
 * that accessors resolve correctly, that services receive proper constructor
 * injection, and that shutdown disposes cleanly.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { asValue } from "awilix";
import { AppContext } from "../app.js";
import { SessionRepository } from "../repositories/session.js";
import { ComputeRepository } from "../repositories/compute.js";
import { EventRepository } from "../repositories/event.js";
import { MessageRepository } from "../repositories/message.js";
import { TodoRepository } from "../repositories/todo.js";
import { SessionService } from "../services/session.js";
import { ComputeService } from "../services/compute.js";
import { HistoryService } from "../services/history.js";
import { clearApp, getApp, setApp } from "./test-helpers.js";

let app: AppContext | null = null;

afterEach(async () => {
  if (app) {
    await app.shutdown();
    clearApp();
    app = null;
  }
});

// ── Container registration ──────────────────────────────────────────────────

describe("DI container registration", () => {
  it("boot() registers all cradle keys", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const container = app.container;
    // All cradle keys should be resolvable
    expect(container.resolve("config")).toBeDefined();
    expect(container.resolve("db")).toBeDefined();
    expect(container.resolve("sessions")).toBeDefined();
    expect(container.resolve("computes")).toBeDefined();
    expect(container.resolve("events")).toBeDefined();
    expect(container.resolve("messages")).toBeDefined();
    expect(container.resolve("todos")).toBeDefined();
    expect(container.resolve("sessionService")).toBeDefined();
    expect(container.resolve("computeService")).toBeDefined();
    expect(container.resolve("historyService")).toBeDefined();
    expect(container.resolve("flows")).toBeDefined();
    expect(container.resolve("skills")).toBeDefined();
    expect(container.resolve("agents")).toBeDefined();
    expect(container.resolve("recipes")).toBeDefined();
  });

  it("config is registered before boot (in constructor)", async () => {
    app = await AppContext.forTestAsync();
    // Config is registered in constructor, not boot
    expect(app.container.resolve("config")).toBeDefined();
    expect(app.container.resolve("config").arkDir).toBeTruthy();
  });

  it("db and repos require boot()", async () => {
    app = await AppContext.forTestAsync();
    expect(() => app!.container.resolve("db")).toThrow();
    expect(() => app!.container.resolve("sessions")).toThrow();
  });
});

// ── Accessor resolution ─────────────────────────────────────────────────────

describe("AppContext accessors resolve from container", () => {
  it("accessors return the same instances as direct container resolve", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    expect(app.db).toBe(app.container.resolve("db"));
    expect(app.sessions).toBe(app.container.resolve("sessions"));
    expect(app.computes).toBe(app.container.resolve("computes"));
    expect(app.events).toBe(app.container.resolve("events"));
    expect(app.messages).toBe(app.container.resolve("messages"));
    expect(app.todos).toBe(app.container.resolve("todos"));
    expect(app.sessionService).toBe(app.container.resolve("sessionService"));
    expect(app.computeService).toBe(app.container.resolve("computeService"));
    expect(app.historyService).toBe(app.container.resolve("historyService"));
    expect(app.flows).toBe(app.container.resolve("flows"));
    expect(app.skills).toBe(app.container.resolve("skills"));
    expect(app.agents).toBe(app.container.resolve("agents"));
    expect(app.recipes).toBe(app.container.resolve("recipes"));
  });

  it("singleton registrations return same instance on repeated resolve", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    // Repositories are registered as singletons
    const s1 = app.sessions;
    const s2 = app.sessions;
    expect(s1).toBe(s2);

    const svc1 = app.sessionService;
    const svc2 = app.sessionService;
    expect(svc1).toBe(svc2);
  });
});

// ── Type correctness ────────────────────────────────────────────────────────

describe("resolved instances have correct types", () => {
  it("repositories are correct classes", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    expect(app.sessions).toBeInstanceOf(SessionRepository);
    expect(app.computes).toBeInstanceOf(ComputeRepository);
    expect(app.events).toBeInstanceOf(EventRepository);
    expect(app.messages).toBeInstanceOf(MessageRepository);
    expect(app.todos).toBeInstanceOf(TodoRepository);
  });

  it("services are correct classes", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    expect(app.sessionService).toBeInstanceOf(SessionService);
    expect(app.computeService).toBeInstanceOf(ComputeService);
    expect(app.historyService).toBeInstanceOf(HistoryService);
  });
});

// ── Dependency injection wiring ─────────────────────────────────────────────

describe("service dependency injection", () => {
  it("SessionService can create and query sessions (repos wired)", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const svc = app.sessionService;
    const session = svc.start({ summary: "DI test", ticket: "DI-1" });
    expect(session.id).toMatch(/^s-[0-9a-z]{10}$/);
    expect(session.summary).toBe("DI test");

    // Verify it's in the DB via the repository
    const fromRepo = app.sessions.get(session.id);
    expect(fromRepo).not.toBeNull();
    expect(fromRepo!.summary).toBe("DI test");

    // Verify event was logged
    const evts = app.events.list(session.id, { type: "session_created" });
    expect(evts.length).toBe(1);
  });

  it("SessionService stop writes through to same DB", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const svc = app.sessionService;
    const session = svc.start({});
    app.sessions.update(session.id, { status: "running" } as any);

    const result = await svc.stop(session.id);
    expect(result.ok).toBe(true);
    expect(app.sessions.get(session.id)!.status).toBe("stopped");
  });

  it("ComputeService delegates to ComputeRepository correctly", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const svc = app.computeService;
    const c = svc.create({ name: "di-docker", provider: "docker" });
    expect(c.name).toBe("di-docker");

    // Verify it's in the DB via the repository
    const fromRepo = app.computes.get("di-docker");
    expect(fromRepo).not.toBeNull();
    expect(fromRepo!.provider).toBe("docker");
  });

  it("HistoryService shares the same DB as repositories", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    // Create a session via service, then search via history
    app.sessionService.start({ summary: "Searchable DI session" });
    const results = app.historyService.search("Searchable DI");
    expect(results.length).toBe(1);
    expect(results[0].match).toBe("Searchable DI session");
  });
});

// ── Test isolation ──────────────────────────────────────────────────────────

describe("forTest() isolation", () => {
  it("two forTest() instances have independent databases", async () => {
    const app1 = await AppContext.forTestAsync();
    await app1.boot();

    const app2 = await AppContext.forTestAsync();
    await app2.boot();

    // Create session in app1
    app1.sessionService.start({ summary: "app1 session" });

    // app2 should not see it
    const results = app2.historyService.search("app1 session");
    expect(results.length).toBe(0);

    // Cleanup
    await app2.shutdown();
    await app1.shutdown();
    app = null; // prevent afterEach double-shutdown
  });

  it("forTest() uses temp directory for arkDir", async () => {
    app = await AppContext.forTestAsync();
    expect(app.arkDir).toContain("ark-test-");
  });

  it("forTest() sets skipConductor, skipMetrics, skipSignals", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    expect(app.conductor).toBeNull();
    expect(app.metricsPoller).toBeNull();
  });

  it("shutdown cleans up temp directory", async () => {
    const tempApp = await AppContext.forTestAsync();
    await tempApp.boot();
    const dir = tempApp.arkDir;

    const { existsSync } = await import("fs");
    expect(existsSync(dir)).toBe(true);

    await tempApp.shutdown();
    expect(existsSync(dir)).toBe(false);
  });
});

// ── Lifecycle phases ────────────────────────────────────────────────────────

describe("container lifecycle phases", () => {
  it("phase transitions: created -> booting -> ready -> shutting_down -> stopped", async () => {
    app = await AppContext.forTestAsync();
    expect(app.phase).toBe("created");

    await app.boot();

    setApp(app);
    expect(app.phase).toBe("ready");

    await app.shutdown();

    clearApp();
    expect(app.phase).toBe("stopped");
    app = null; // prevent afterEach double-shutdown
  });

  it("double boot throws", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    await expect(app.boot()).rejects.toThrow("Cannot boot");
  });

  it("double shutdown is idempotent", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    await app.shutdown();

    clearApp();
    // Should not throw
    await app.shutdown();
    clearApp();
    app = null; // prevent afterEach double-shutdown
  }, 15_000);

  it("shutdown without boot (fast path) reaches stopped", async () => {
    app = await AppContext.forTestAsync();
    expect(app.phase).toBe("created");

    await app.shutdown();

    clearApp();
    expect(app.phase).toBe("stopped");
    app = null;
  });

  it("shutdown without boot cleans up temp directory", async () => {
    const tempApp = await AppContext.forTestAsync();
    const dir = tempApp.arkDir;

    const { existsSync } = await import("fs");
    // arkDir might not exist yet since boot wasn't called, but if it does it should be cleaned
    const existedBefore = existsSync(dir);

    await tempApp.shutdown();
    if (existedBefore) {
      expect(existsSync(dir)).toBe(false);
    }
    expect(tempApp.phase).toBe("stopped");
  });

  // "shutdown without boot clears global singleton" was deleted -- the
  // AppContext global singleton it exercised has been removed.
});

// ── Resource stores ─────────────────────────────────────────────────────────

describe("resource stores via container", () => {
  it("flows store is accessible and has list()", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const flows = app.flows;
    expect(typeof flows.list).toBe("function");
    // Should at least have builtin flows
    const list = flows.list();
    expect(list.length).toBeGreaterThanOrEqual(0);
  });

  it("skills store is accessible and has list()", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const skills = app.skills;
    expect(typeof skills.list).toBe("function");
  });

  it("agents store is accessible and has list()", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const agents = app.agents;
    expect(typeof agents.list).toBe("function");
  });

  it("recipes store is accessible and has list()", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const recipes = app.recipes;
    expect(typeof recipes.list).toBe("function");
  });
});

// ── Cross-service integration ───────────────────────────────────────────────

describe("cross-service integration through container", () => {
  it("full session lifecycle through DI-wired services", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const svc = app.sessionService;

    // Create
    const session = svc.start({ summary: "Full lifecycle", ticket: "LC-1" });
    expect(session.status).toBe("pending");

    // Pause
    const pauseResult = svc.pause(session.id, "Waiting for review");
    expect(pauseResult.ok).toBe(true);
    expect(app.sessions.get(session.id)!.status).toBe("blocked");

    // Resume
    const resumeResult = await svc.resume(session.id);
    expect(resumeResult.ok).toBe(true);
    expect(app.sessions.get(session.id)!.status).toBe("ready");

    // Stop
    const stopResult = await svc.stop(session.id);
    expect(stopResult.ok).toBe(true);
    expect(app.sessions.get(session.id)!.status).toBe("stopped");

    // Delete
    const deleteResult = await svc.delete(session.id);
    expect(deleteResult.ok).toBe(true);
    expect(app.sessions.get(session.id)!.status).toBe("deleting");

    // Undelete
    const undeleteResult = await svc.undelete(session.id);
    expect(undeleteResult.ok).toBe(true);
    expect(app.sessions.get(session.id)!.status).toBe("stopped");

    // Verify events trail
    const allEvents = app.events.list(session.id);
    const types = allEvents.map((e) => e.type);
    expect(types).toContain("session_created");
    expect(types).toContain("session_paused");
    expect(types).toContain("session_resumed");
    expect(types).toContain("session_stopped");
    expect(types).toContain("session_deleted");
    expect(types).toContain("session_undeleted");
  });

  it("session + compute coexist in same container", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    // Create session and compute through services
    const session = app.sessionService.start({ summary: "With compute" });
    const compute = app.computeService.create({ name: "test-ec2", provider: "ec2" });

    // Both write to the same underlying database
    expect(app.sessions.get(session.id)).not.toBeNull();
    expect(app.computes.get("test-ec2")).not.toBeNull();

    // History service sees the session
    const results = app.historyService.search("With compute");
    expect(results.length).toBe(1);
  });

  it("messages sent through repo are visible via service complete()", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const session = app.sessionService.start({ summary: "Msg test" });
    app.messages.send(session.id, "agent", "Done!", "text");
    expect(app.messages.unreadCount(session.id)).toBe(1);

    // complete() marks messages as read
    app.sessionService.complete(session.id);
    expect(app.messages.unreadCount(session.id)).toBe(0);
  });
});

// -- Transitive dependency sharing ------------------------------------------

describe("transitive dependency sharing", () => {
  it("SessionService and SessionRepository share the same DB", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const session = app.sessionService.start({ summary: "Shared DB test" });

    // Write directly to the DB via the db accessor
    const row = app.db.prepare("SELECT id FROM sessions WHERE id = ?").get(session.id) as { id: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe(session.id);
  });

  it("HistoryService queries the same DB that repos write to", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    app.sessionService.start({ summary: "History transitive test" });

    const results = app.historyService.search("History transitive");
    expect(results.length).toBe(1);
  });

  it("all repos resolve with the same DB instance", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const db = app.container.resolve("db");
    expect(app.db).toBe(db);

    const session = app.sessions.create({});
    app.events.log(session.id, "test_event", { actor: "test" });

    const events = app.events.list(session.id, { type: "test_event" });
    expect(events.length).toBe(1);
  });

  it("todos repo shares DB with sessions repo", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const session = app.sessions.create({});
    app.todos.add(session.id, "Test todo");
    const todos = app.todos.list(session.id);
    expect(todos.length).toBe(1);
    expect(todos[0].content).toBe("Test todo");
  });
});

// -- Container override for test doubles ------------------------------------

describe("container override", () => {
  it("can override a singleton registration with asValue", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const session = app.sessionService.start({ summary: "Before override" });
    expect(app.sessions.get(session.id)).not.toBeNull();

    const fakeSessions = {
      get: (id: string) => ({ id, summary: "FAKE", status: "pending" }),
    };
    app.container.register({ sessions: asValue(fakeSessions) });

    const resolved = app.container.resolve("sessions");
    expect(resolved.get("s-000000")!.summary).toBe("FAKE");
  });

  it("override does not affect previously resolved singletons held by reference", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const originalRepo = app.sessions;
    const session = app.sessionService.start({ summary: "ref test" });

    app.container.register({ sessions: asValue({ get: () => null }) });

    // The original reference still works
    expect(originalRepo.get(session.id)).not.toBeNull();
    expect(originalRepo.get(session.id)!.summary).toBe("ref test");
  });
});

// -- Post-shutdown behavior -------------------------------------------------

describe("post-shutdown behavior", () => {
  it("phase is stopped after shutdown and DB is closed", async () => {
    const tempApp = await AppContext.forTestAsync();
    await tempApp.boot();

    expect(tempApp.sessions).toBeDefined();

    await tempApp.shutdown();

    expect(tempApp.phase).toBe("stopped");

    // DB was closed during shutdown
    expect(() => tempApp.container.resolve("db").prepare("SELECT 1").get()).toThrow();
  });

  it("boot after shutdown throws (no reuse)", async () => {
    const tempApp = await AppContext.forTestAsync();
    await tempApp.boot();
    await tempApp.shutdown();

    await expect(tempApp.boot()).rejects.toThrow();
  });

  it("temp directory is removed after shutdown with cleanupOnShutdown", async () => {
    const tempApp = await AppContext.forTestAsync();
    await tempApp.boot();
    const dir = tempApp.arkDir;

    const { existsSync } = await import("fs");
    expect(existsSync(dir)).toBe(true);

    await tempApp.shutdown();
    expect(existsSync(dir)).toBe(false);
  });
});

// -- getApp() global singleton integration ----------------------------------

describe("getApp() global singleton integration", () => {
  it("getApp() resolves same instances as direct container access", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const global = getApp();
    expect(global.sessions).toBe(app.sessions);
    expect(global.sessionService).toBe(app.sessionService);
    expect(global.db).toBe(app.db);
  });

  // "getApp() throws when no app is set" and "setApp replaces the global
  // singleton" exercised the module-level AppContext singleton that has
  // been removed.

  it("data written through getApp() is visible through direct app reference", async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);

    const session = getApp().sessionService.start({ summary: "Global write" });

    const found = app.sessions.get(session.id);
    expect(found).not.toBeNull();
    expect(found!.summary).toBe("Global write");
  });
});

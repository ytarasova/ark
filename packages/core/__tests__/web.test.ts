import { describe, it, expect, afterEach } from "bun:test";
import { startWebServer } from "../web.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "../app.js";
import { remember } from "../memory.js";

withTestContext();

describe("web server", () => {
  let server: { stop: () => void; url: string } | null = null;
  afterEach(() => { server?.stop(); server = null; });

  it("starts and serves dashboard HTML", async () => {
    server = startWebServer({ port: 18420 });
    const resp = await fetch("http://localhost:18420/");
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("Ark Dashboard");
  });

  it("serves session list API", async () => {
    getApp().sessions.create({ summary: "web-test" });
    server = startWebServer({ port: 18421 });
    const resp = await fetch("http://localhost:18421/api/sessions");
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((s: any) => s.summary === "web-test")).toBe(true);
  });

  it("serves costs API", async () => {
    server = startWebServer({ port: 18422 });
    const resp = await fetch("http://localhost:18422/api/costs");
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(data).toHaveProperty("total");
    expect(data).toHaveProperty("sessions");
  });

  it("returns 404 for unknown routes", async () => {
    server = startWebServer({ port: 18423 });
    const resp = await fetch("http://localhost:18423/nope");
    expect(resp.status).toBe(404);
  });

  it("enforces token auth when configured", async () => {
    server = startWebServer({ port: 18424, token: "secret123" });
    const noAuth = await fetch("http://localhost:18424/api/sessions");
    expect(noAuth.status).toBe(401);
    const withAuth = await fetch("http://localhost:18424/api/sessions?token=secret123");
    expect(withAuth.status).toBe(200);
  });

  it("returns session detail with events", async () => {
    const s = getApp().sessions.create({ summary: "detail-test" });
    server = startWebServer({ port: 18425 });
    const resp = await fetch(`http://localhost:18425/api/sessions/${s.id}`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(data.session.id).toBe(s.id);
    expect(Array.isArray(data.events)).toBe(true);
  });

  it("returns 404 for missing session", async () => {
    server = startWebServer({ port: 18426 });
    const resp = await fetch("http://localhost:18426/api/sessions/nonexistent");
    expect(resp.status).toBe(404);
  });

  it("creates a session via POST", async () => {
    server = startWebServer({ port: 18430 });
    const resp = await fetch("http://localhost:18430/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "web-create-test", repo: "." }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(data.ok).toBe(true);
    expect(data.session).toBeDefined();
    expect(data.session.summary).toBe("web-create-test");
  });

  it("returns system status", async () => {
    getApp().sessions.create({ summary: "status-test-1" });
    getApp().sessions.create({ summary: "status-test-2" });
    server = startWebServer({ port: 18431 });
    const resp = await fetch("http://localhost:18431/api/status");
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(data).toHaveProperty("total");
    expect(data).toHaveProperty("byStatus");
    expect(typeof data.total).toBe("number");
    expect(data.total).toBeGreaterThanOrEqual(2);
  });

  it("returns groups", async () => {
    server = startWebServer({ port: 18432 });
    const resp = await fetch("http://localhost:18432/api/groups");
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(Array.isArray(data)).toBe(true);
  });

  it("handles CORS preflight", async () => {
    server = startWebServer({ port: 18433 });
    const resp = await fetch("http://localhost:18433/api/sessions", { method: "OPTIONS" });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rejects POST in read-only mode", async () => {
    server = startWebServer({ port: 18434, readOnly: true });
    const resp = await fetch("http://localhost:18434/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "should-fail" }),
    });
    const data = await resp.json() as any;
    expect(data.ok).toBe(false);
    expect(data.message).toContain("Read-only");
  });

  // --- New endpoint tests ---

  it("POST /api/sessions/:id/fork clones a session", async () => {
    const s = getApp().sessions.create({ summary: "fork-me" });
    server = startWebServer({ port: 18535 });
    const resp = await fetch(`http://localhost:18535/api/sessions/${s.id}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "forked-copy" }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(data.ok).toBe(true);
    expect(data.sessionId).toBeDefined();
  });

  it("GET /api/profiles returns profile list", async () => {
    server = startWebServer({ port: 18536 });
    const resp = await fetch("http://localhost:18536/api/profiles");
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((p: any) => p.name === "default")).toBe(true);
  });

  it("GET /api/search requires q param", async () => {
    server = startWebServer({ port: 18538 });
    const resp = await fetch("http://localhost:18538/api/search");
    expect(resp.status).toBe(400);
  });

  it("GET /api/agents returns agent list", async () => {
    server = startWebServer({ port: 18539 });
    const resp = await fetch("http://localhost:18539/api/agents");
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(Array.isArray(data)).toBe(true);
  });

  it("GET /api/memory returns memory list", async () => {
    server = startWebServer({ port: 18540 });
    const resp = await fetch("http://localhost:18540/api/memory");
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(Array.isArray(data)).toBe(true);
  });

  it("GET /api/compute returns compute list", async () => {
    server = startWebServer({ port: 18541 });
    const resp = await fetch("http://localhost:18541/api/compute");
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(Array.isArray(data)).toBe(true);
  });

  it("GET /api/config returns system config", async () => {
    server = startWebServer({ port: 18542 });
    const resp = await fetch("http://localhost:18542/api/config");
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(data).toHaveProperty("hotkeys");
    expect(data).toHaveProperty("theme");
    expect(data).toHaveProperty("profile");
  });

  it("GET /api/sessions/:id/events returns events standalone", async () => {
    const s = getApp().sessions.create({ summary: "events-test" });
    server = startWebServer({ port: 18543 });
    const resp = await fetch(`http://localhost:18543/api/sessions/${s.id}/events`);
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(Array.isArray(data)).toBe(true);
  });

  it("GET /api/flows returns flow list", async () => {
    server = startWebServer({ port: 18544 });
    const resp = await fetch("http://localhost:18544/api/flows");
    expect(resp.status).toBe(200);
    const data = await resp.json() as any;
    expect(Array.isArray(data)).toBe(true);
  });
});

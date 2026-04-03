import { describe, it, expect, afterEach } from "bun:test";
import { startWebServer } from "../web.js";
import { withTestContext } from "./test-helpers.js";
import { createSession } from "../store.js";

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
    createSession({ summary: "web-test" });
    server = startWebServer({ port: 18421 });
    const resp = await fetch("http://localhost:18421/api/sessions");
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.some((s: any) => s.summary === "web-test")).toBe(true);
  });

  it("serves costs API", async () => {
    server = startWebServer({ port: 18422 });
    const resp = await fetch("http://localhost:18422/api/costs");
    expect(resp.status).toBe(200);
    const data = await resp.json();
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
    const s = createSession({ summary: "detail-test" });
    server = startWebServer({ port: 18425 });
    const resp = await fetch(`http://localhost:18425/api/sessions/${s.id}`);
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.session.id).toBe(s.id);
    expect(Array.isArray(data.events)).toBe(true);
  });

  it("returns 404 for missing session", async () => {
    server = startWebServer({ port: 18426 });
    const resp = await fetch("http://localhost:18426/api/sessions/nonexistent");
    expect(resp.status).toBe(404);
  });
});

/**
 * Deny-path tests for P1-1 (spoofable tenant identity) and P1-2
 * (cross-tenant REST leak).
 *
 * Preconditions the tests pin down:
 *   P1-1:
 *     - `X-Ark-Tenant-Id` alone is never trusted. A request with only the
 *       header (no Bearer token) is rejected.
 *     - A Bearer token that does not resolve to an api_keys row is rejected.
 *     - A validated Bearer + mismatched X-Ark-Tenant-Id returns 403.
 *     - `"default"` is still permitted when neither header is present AND
 *       the conductor is in local single-tenant mode (no databaseUrl).
 *
 *   P1-2:
 *     - `GET /api/sessions` with a tenant-A token returns only tenant-A
 *       rows. A tenant-B session is invisible.
 *     - `GET /api/sessions/:id` of tenant-B's session via a tenant-A
 *       token returns 404 (not 200 with the foreign row).
 *     - `GET /api/events/:id` of tenant-B's session via a tenant-A token
 *       returns 404.
 *     - `GET /health` continues to work unauthenticated.
 *
 * The tests simulate hosted mode (auth required) by setting
 * `config.databaseUrl = "sqlite://local"` -- the conductor reads this as
 * "not local single-tenant" and denies unauthenticated calls. A real
 * hosted deployment would use a Postgres URL; the conductor only checks
 * that the field is truthy.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../app.js";
import { startConductor } from "../conductor/conductor.js";

const TEST_PORT = 19198;
const BASE = `http://localhost:${TEST_PORT}`;

let app: AppContext;
let server: { stop(): void };

async function boot(opts: { hostedMode: boolean }): Promise<void> {
  if (app) {
    try {
      server?.stop();
    } catch {
      /* stop may throw if double-stopped */
    }
    await app.shutdown();
  }
  app = await AppContext.forTestAsync();
  if (opts.hostedMode) {
    (app.config as { databaseUrl?: string }).databaseUrl = "sqlite://test-hosted";
  }
  await app.boot();
  server = startConductor(app, TEST_PORT, { quiet: true });
}

async function postChannel(sessionId: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE}/api/channel/${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ type: "progress", sessionId, stage: "work", message: "hi" }),
  });
}

beforeEach(async () => {
  await boot({ hostedMode: true });
});

afterEach(async () => {
  try {
    server.stop();
  } catch {
    /* already stopped */
  }
  await app.shutdown();
});

describe("P1-1 -- conductor tenant identity must not be spoofable", () => {
  it("rejects X-Ark-Tenant-Id header without a Bearer token", async () => {
    const resp = await postChannel("s-nope", { "X-Ark-Tenant-Id": "attacker-picks-anything" });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as any;
    expect(body.error).toMatch(/requires a validated Authorization/i);
  });

  it("rejects a Bearer token that does not match any api_keys row", async () => {
    const resp = await postChannel("s-nope", { Authorization: "Bearer ark_fake_not-a-real-secret" });
    expect(resp.status).toBe(401);
    const body = (await resp.json()) as any;
    expect(body.error).toMatch(/invalid or expired/i);
  });

  it("rejects unauthenticated request in hosted mode", async () => {
    const resp = await postChannel("s-nope");
    expect(resp.status).toBe(401);
  });

  it("rejects when X-Ark-Tenant-Id disagrees with the validated token", async () => {
    const { key } = app.apiKeys.create("tenant-a", "test key", "admin");
    const resp = await postChannel("s-nope", {
      Authorization: `Bearer ${key}`,
      "X-Ark-Tenant-Id": "tenant-b-victim",
    });
    expect(resp.status).toBe(403);
    const body = (await resp.json()) as any;
    expect(body.error).toMatch(/tenant header does not match/i);
  });

  it("a valid token is accepted (positive control)", async () => {
    const { key } = app.apiKeys.create("tenant-a", "test key", "admin");
    const resp = await postChannel("s-anything", { Authorization: `Bearer ${key}` });
    // The session does not exist but auth passed -- either 200 (accepted and
    // ignored because no session) or a non-auth error. It must NOT be 401/403.
    expect(resp.status).not.toBe(401);
    expect(resp.status).not.toBe(403);
  });
});

describe("P1-1 -- local single-tenant mode is preserved when no credentials are present", () => {
  it("allows unauthenticated requests in local mode (no databaseUrl)", async () => {
    await boot({ hostedMode: false });
    const resp = await postChannel("s-local");
    expect(resp.status).toBe(200);
  });

  it("still rejects a header-only request in local mode (spoofable)", async () => {
    await boot({ hostedMode: false });
    const resp = await postChannel("s-local", { "X-Ark-Tenant-Id": "attacker" });
    expect(resp.status).toBe(401);
  });
});

describe("P1-2 -- cross-tenant REST leak", () => {
  async function createSessionForTenant(tenantId: string, summary: string): Promise<string> {
    const scoped = app.forTenant(tenantId);
    const session = scoped.sessions.create({ summary });
    return session.id;
  }

  it("GET /api/sessions scopes rows to the caller's tenant", async () => {
    const { key: keyA } = app.apiKeys.create("tenant-a", "a", "admin");
    app.apiKeys.create("tenant-b", "b", "admin");

    await createSessionForTenant("tenant-a", "a-session");
    const bSessionId = await createSessionForTenant("tenant-b", "b-session");

    const resp = await fetch(`${BASE}/api/sessions`, {
      headers: { Authorization: `Bearer ${keyA}` },
    });
    expect(resp.status).toBe(200);
    const list = (await resp.json()) as Array<{ id: string; summary: string }>;
    const summaries = list.map((s) => s.summary);
    expect(summaries).toContain("a-session");
    expect(summaries).not.toContain("b-session");
    // Extra-specific: tenant-a must not see tenant-b's row even by id.
    expect(list.find((s) => s.id === bSessionId)).toBeUndefined();
  });

  it("GET /api/sessions scopes rows -- unauthenticated hosted-mode call is 401", async () => {
    await createSessionForTenant("tenant-b", "b-session");
    const resp = await fetch(`${BASE}/api/sessions`);
    expect(resp.status).toBe(401);
  });

  it("GET /api/sessions/:id of another tenant's session returns 404", async () => {
    const { key: keyA } = app.apiKeys.create("tenant-a", "a", "admin");
    const bSessionId = await createSessionForTenant("tenant-b", "b-session");
    const resp = await fetch(`${BASE}/api/sessions/${bSessionId}`, {
      headers: { Authorization: `Bearer ${keyA}` },
    });
    expect(resp.status).toBe(404);
  });

  it("GET /api/events/:id of another tenant's session returns 404", async () => {
    const { key: keyA } = app.apiKeys.create("tenant-a", "a", "admin");
    const bSessionId = await createSessionForTenant("tenant-b", "b-session");
    const resp = await fetch(`${BASE}/api/events/${bSessionId}`, {
      headers: { Authorization: `Bearer ${keyA}` },
    });
    expect(resp.status).toBe(404);
  });

  it("GET /health still works without auth (used by probes)", async () => {
    const resp = await fetch(`${BASE}/health`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as any;
    expect(body.status).toBe("ok");
  });
});

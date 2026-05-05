/**
 * Deny-path tests for P1-1 (spoofable tenant identity) and P1-2
 * (cross-tenant REST leak).
 *
 * Preconditions the tests pin down:
 *   P1-1 (hosted mode):
 *     - `X-Ark-Tenant-Id` alone is never trusted. A hosted-mode request
 *       with only the header (no Bearer token) is rejected with 401.
 *     - A Bearer token that does not resolve to an api_keys row is rejected.
 *     - A validated Bearer + mismatched X-Ark-Tenant-Id returns 403.
 *   P1-1 (local mode):
 *     - No headers -> fall through to tenant "default".
 *     - Only `X-Ark-Tenant-Id` (no Bearer) is accepted verbatim. Local mode
 *       is single-user; the header is informational and can't widen access,
 *       and the channel MCP subprocess always sets it at dispatch.
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
 * `config.database.url = "sqlite://local"` -- the conductor reads this as
 * "not local single-tenant" and denies unauthenticated calls. A real
 * hosted deployment would use a Postgres URL; the conductor only checks
 * that the field is truthy.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../app.js";
import { startConductor } from "../conductor/server/conductor.js";

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
  await app.boot();
  if (opts.hostedMode) {
    // Swap the DI-registered AppMode to the hosted impl AFTER boot so we
    // exercise the hosted-mode tenant resolver (P1-1 contract) without
    // forcing the boot path to open a real Postgres connection. The test
    // context's SQLite adapter stays bound at `app.db`.
    const { buildHostedAppMode } = await import("../modes/app-mode.js");
    const { asValue } = await import("awilix");
    const hostedMode = buildHostedAppMode({ dialect: "postgres", url: "postgres://test-hosted" });
    (app as unknown as { _container: { register: (r: Record<string, unknown>) => void } })._container.register({
      mode: asValue(hostedMode),
    });
  }
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

describe("P1-1 -- conductor tenant identity must not be spoofable", async () => {
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
    const { key } = await app.apiKeys.create("tenant-a", "test key", "admin");
    const resp = await postChannel("s-nope", {
      Authorization: `Bearer ${key}`,
      "X-Ark-Tenant-Id": "tenant-b-victim",
    });
    expect(resp.status).toBe(403);
    const body = (await resp.json()) as any;
    expect(body.error).toMatch(/tenant header does not match/i);
  });

  it("a valid token is accepted (positive control)", async () => {
    const { key } = await app.apiKeys.create("tenant-a", "test key", "admin");
    const resp = await postChannel("s-anything", { Authorization: `Bearer ${key}` });
    // The session does not exist but auth passed -- either 200 (accepted and
    // ignored because no session) or a non-auth error. It must NOT be 401/403.
    expect(resp.status).not.toBe(401);
    expect(resp.status).not.toBe(403);
  });
});

describe("P1-1 -- local single-tenant mode accepts the channel MCP's informational tenant header", async () => {
  it("allows unauthenticated requests in local mode (no databaseUrl)", async () => {
    await boot({ hostedMode: false });
    const resp = await postChannel("s-local");
    expect(resp.status).toBe(200);
  });

  it("accepts `X-Ark-Tenant-Id: default` without a Bearer in local mode", async () => {
    // The channel MCP subprocess always injects ARK_TENANT_ID and the
    // channel server forwards it as X-Ark-Tenant-Id. Local mode must
    // accept this -- rejecting would 401 every `report` + relay + hooks
    // call, which is the regression we fixed (commit SHA lives in the
    // conductor-auth test replacement for this one).
    await boot({ hostedMode: false });
    const resp = await postChannel("s-local", { "X-Ark-Tenant-Id": "default" });
    expect(resp.status).toBe(200);
  });
});

describe("P1-2 -- cross-tenant REST leak", async () => {
  async function createSessionForTenant(tenantId: string, summary: string): Promise<string> {
    const scoped = app.forTenant(tenantId);
    const session = await scoped.sessions.create({ summary });
    return session.id;
  }

  it("GET /api/sessions scopes rows to the caller's tenant", async () => {
    const { key: keyA } = await app.apiKeys.create("tenant-a", "a", "admin");
    await app.apiKeys.create("tenant-b", "b", "admin");

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
    const { key: keyA } = await app.apiKeys.create("tenant-a", "a", "admin");
    const bSessionId = await createSessionForTenant("tenant-b", "b-session");
    const resp = await fetch(`${BASE}/api/sessions/${bSessionId}`, {
      headers: { Authorization: `Bearer ${keyA}` },
    });
    expect(resp.status).toBe(404);
  });

  it("GET /api/events/:id of another tenant's session returns 404", async () => {
    const { key: keyA } = await app.apiKeys.create("tenant-a", "a", "admin");
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

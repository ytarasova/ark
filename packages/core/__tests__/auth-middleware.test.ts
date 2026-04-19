/**
 * Auth middleware tests.
 *
 * Covers: extractTenantContext resolution order, canWrite/isAdmin role gating,
 * and default behavior when auth is disabled.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  extractTenantContext,
  canWrite,
  isAdmin,
  DEFAULT_AUTH_CONFIG,
  DEFAULT_TENANT_CONTEXT,
} from "../auth/middleware.js";
import { ApiKeyManager } from "../auth/api-keys.js";
import { AppContext, setApp, clearApp } from "../app.js";
import type { TenantContext } from "../types/index.js";

let app: AppContext;
let keyManager: ApiKeyManager;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
  keyManager = new ApiKeyManager(app.db);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

function mkReq(headers: Record<string, string> = {}, url = "http://localhost/api"): Request {
  return new Request(url, { headers });
}

describe("extractTenantContext - auth disabled", () => {
  it("returns the default context when auth is disabled, regardless of headers", () => {
    const ctx = extractTenantContext(mkReq({ authorization: "Bearer bogus" }), DEFAULT_AUTH_CONFIG, null);
    expect(ctx).toEqual(DEFAULT_TENANT_CONTEXT);
  });

  it("returns the default context when auth is disabled and no credentials are present", () => {
    const ctx = extractTenantContext(mkReq(), DEFAULT_AUTH_CONFIG, null);
    expect(ctx?.tenantId).toBe("default");
    expect(ctx?.role).toBe("admin");
  });
});

describe("extractTenantContext - auth enabled", () => {
  const config = { enabled: true, apiKeyEnabled: true };

  it("returns null when no credentials are provided", () => {
    const ctx = extractTenantContext(mkReq(), config, keyManager);
    expect(ctx).toBeNull();
  });

  it("returns null when the Bearer token is invalid", () => {
    const ctx = extractTenantContext(mkReq({ authorization: "Bearer ark_default_nope" }), config, keyManager);
    expect(ctx).toBeNull();
  });

  it("returns a context with the right tenant + role when a valid Bearer token is provided", () => {
    const { key, id } = keyManager.create("acme", "test-key", "member");
    expect(id).toMatch(/^ak-/);

    const ctx = extractTenantContext(mkReq({ authorization: `Bearer ${key}` }), config, keyManager);
    expect(ctx).not.toBeNull();
    expect(ctx?.tenantId).toBe("acme");
    expect(ctx?.role).toBe("member");
  });

  it("accepts the token via ?token= query param as a fallback", () => {
    const { key } = keyManager.create("qparam", "q-key", "admin");
    const ctx = extractTenantContext(mkReq({}, `http://localhost/api?token=${key}`), config, keyManager);
    expect(ctx?.tenantId).toBe("qparam");
    expect(ctx?.role).toBe("admin");
  });

  it("prefers the Authorization header over a ?token= query param", () => {
    const a = keyManager.create("header-wins", "h", "admin");
    const b = keyManager.create("query-loses", "q", "viewer");
    const ctx = extractTenantContext(
      mkReq({ authorization: `Bearer ${a.key}` }, `http://localhost/api?token=${b.key}`),
      { enabled: true, apiKeyEnabled: true },
      keyManager,
    );
    expect(ctx?.tenantId).toBe("header-wins");
  });

  it("returns null when an API key manager is not provided even if the token looks valid", () => {
    const ctx = extractTenantContext(mkReq({ authorization: "Bearer ark_default_anything" }), config, null);
    expect(ctx).toBeNull();
  });
});

describe("role predicates", () => {
  const admin: TenantContext = { tenantId: "t", userId: "u", role: "admin" };
  const member: TenantContext = { tenantId: "t", userId: "u", role: "member" };
  const viewer: TenantContext = { tenantId: "t", userId: "u", role: "viewer" };

  it("canWrite is true for admin and member, false for viewer", () => {
    expect(canWrite(admin)).toBe(true);
    expect(canWrite(member)).toBe(true);
    expect(canWrite(viewer)).toBe(false);
  });

  it("isAdmin only matches the admin role", () => {
    expect(isAdmin(admin)).toBe(true);
    expect(isAdmin(member)).toBe(false);
    expect(isAdmin(viewer)).toBe(false);
  });
});

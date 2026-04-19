/**
 * Tests for API key management (create, validate, revoke, rotate, expiry).
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";

let app: AppContext;

beforeEach(async () => {
  if (app) {
    await app.shutdown();
    clearApp();
  }
  app = await AppContext.forTestAsync();
  setApp(app);
  await app.boot();
});

afterAll(async () => {
  if (app) {
    await app.shutdown();
    clearApp();
  }
});

describe("ApiKeyManager", () => {
  describe("create", () => {
    it("creates a key with the correct format", () => {
      const result = app.apiKeys.create("test-tenant", "my key", "member");
      expect(result.key).toMatch(/^ark_test-tenant_[a-f0-9]+$/);
      expect(result.id).toMatch(/^ak-[a-f0-9]+$/);
    });

    it("creates keys with different roles", () => {
      const admin = app.apiKeys.create("t1", "admin key", "admin");
      const member = app.apiKeys.create("t1", "member key", "member");
      const viewer = app.apiKeys.create("t1", "viewer key", "viewer");

      expect(admin.key).toBeTruthy();
      expect(member.key).toBeTruthy();
      expect(viewer.key).toBeTruthy();

      // All should be different
      expect(new Set([admin.key, member.key, viewer.key]).size).toBe(3);
    });
  });

  describe("validate", () => {
    it("validates a valid key and returns tenant context", () => {
      const { key } = app.apiKeys.create("acme", "ci-key", "member");
      const ctx = app.apiKeys.validate(key);

      expect(ctx).not.toBeNull();
      expect(ctx!.tenantId).toBe("acme");
      expect(ctx!.role).toBe("member");
    });

    it("returns null for invalid key", () => {
      const ctx = app.apiKeys.validate("ark_fake_notreal");
      expect(ctx).toBeNull();
    });

    it("returns null for malformed key", () => {
      expect(app.apiKeys.validate("not-an-ark-key")).toBeNull();
      expect(app.apiKeys.validate("")).toBeNull();
      expect(app.apiKeys.validate("ark_")).toBeNull();
    });

    it("updates last_used_at on successful validation", () => {
      const { key, id } = app.apiKeys.create("acme", "track-usage", "admin");
      const keysBefore = app.apiKeys.list("acme");
      const before = keysBefore.find((k) => k.id === id);
      expect(before!.lastUsedAt).toBeNull();

      app.apiKeys.validate(key);

      const keysAfter = app.apiKeys.list("acme");
      const after = keysAfter.find((k) => k.id === id);
      expect(after!.lastUsedAt).not.toBeNull();
    });

    it("rejects expired keys", () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
      const { key } = app.apiKeys.create("acme", "expired-key", "member", pastDate);
      const ctx = app.apiKeys.validate(key);
      expect(ctx).toBeNull();
    });

    it("accepts non-expired keys", () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString(); // 1 day from now
      const { key } = app.apiKeys.create("acme", "valid-key", "member", futureDate);
      const ctx = app.apiKeys.validate(key);
      expect(ctx).not.toBeNull();
      expect(ctx!.tenantId).toBe("acme");
    });
  });

  describe("list", () => {
    it("lists keys for a specific tenant", () => {
      app.apiKeys.create("tenant-a", "key-1", "admin");
      app.apiKeys.create("tenant-a", "key-2", "member");
      app.apiKeys.create("tenant-b", "key-3", "viewer");

      const keysA = app.apiKeys.list("tenant-a");
      expect(keysA.length).toBe(2);
      expect(keysA.every((k) => k.tenantId === "tenant-a")).toBe(true);

      const keysB = app.apiKeys.list("tenant-b");
      expect(keysB.length).toBe(1);
      expect(keysB[0].tenantId).toBe("tenant-b");
    });

    it("returns empty array for nonexistent tenant", () => {
      const keys = app.apiKeys.list("nobody");
      expect(keys).toEqual([]);
    });
  });

  describe("revoke", () => {
    it("revokes an existing key", () => {
      const { key, id } = app.apiKeys.create("acme", "to-revoke", "member");
      expect(app.apiKeys.validate(key)).not.toBeNull();

      const ok = app.apiKeys.revoke(id);
      expect(ok).toBe(true);

      // Key should no longer validate
      expect(app.apiKeys.validate(key)).toBeNull();
    });

    it("returns false for nonexistent key", () => {
      const ok = app.apiKeys.revoke("ak-nonexistent");
      expect(ok).toBe(false);
    });
  });

  describe("rotate", () => {
    it("creates a new key and revokes the old one", () => {
      const original = app.apiKeys.create("acme", "rotate-me", "admin");
      const rotated = app.apiKeys.rotate(original.id);

      expect(rotated).not.toBeNull();
      expect(rotated!.key).not.toBe(original.key);
      expect(rotated!.key).toMatch(/^ark_acme_/);

      // Old key should be invalid
      expect(app.apiKeys.validate(original.key)).toBeNull();

      // New key should be valid
      const ctx = app.apiKeys.validate(rotated!.key);
      expect(ctx).not.toBeNull();
      expect(ctx!.tenantId).toBe("acme");
      expect(ctx!.role).toBe("admin");
    });

    it("returns null for nonexistent key", () => {
      const result = app.apiKeys.rotate("ak-nonexistent");
      expect(result).toBeNull();
    });
  });
});

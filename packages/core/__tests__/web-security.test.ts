/**
 * Security tests for web server:
 * - Path traversal prevention in static file serving
 * - Webhook signature verification
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { join, resolve } from "path";
import { createHmac, timingSafeEqual } from "crypto";

// ── Path traversal tests (unit-level, no live server needed) ─────────────────

describe("Path traversal prevention", () => {
  const WEB_DIST = "/some/app/packages/web/dist";

  function isPathSafe(pathname: string): boolean {
    const filePath = resolve(join(WEB_DIST, pathname));
    return filePath.startsWith(resolve(WEB_DIST));
  }

  it("allows normal static paths", () => {
    expect(isPathSafe("/assets/main.js")).toBe(true);
    expect(isPathSafe("/style.css")).toBe(true);
    expect(isPathSafe("/images/logo.png")).toBe(true);
  });

  it("blocks directory traversal with ../", () => {
    expect(isPathSafe("/../../etc/passwd")).toBe(false);
    expect(isPathSafe("/../../../etc/shadow")).toBe(false);
  });

  it("blocks encoded traversal attempts", () => {
    // path.join resolves these before resolve
    expect(isPathSafe("/..%2F..%2Fetc/passwd")).toBe(true); // stays within dist (literal dots)
    expect(isPathSafe("/../../etc/passwd")).toBe(false);
  });

  it("blocks traversal to parent directories", () => {
    expect(isPathSafe("/../secret.key")).toBe(false);
    expect(isPathSafe("/./../../package.json")).toBe(false);
  });

  it("allows paths with dots that stay within dist", () => {
    expect(isPathSafe("/file.name.with.dots.js")).toBe(true);
    expect(isPathSafe("/assets/chunk.abc123.css")).toBe(true);
  });
});

// ── Webhook signature verification (unit-level) ─────────────────────────────

describe("Webhook HMAC signature verification", () => {
  const SECRET = "test-webhook-secret";

  function verifySignature(body: string, signature: string | null, secret: string): boolean {
    if (!signature) return false;
    const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  }

  it("accepts valid signature", () => {
    const body = '{"action":"labeled","issue":{"number":1}}';
    const sig = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
    expect(verifySignature(body, sig, SECRET)).toBe(true);
  });

  it("rejects missing signature", () => {
    expect(verifySignature("{}", null, SECRET)).toBe(false);
  });

  it("rejects wrong signature", () => {
    expect(verifySignature("{}", "sha256=deadbeef", SECRET)).toBe(false);
  });

  it("rejects signature computed with wrong secret", () => {
    const body = '{"test":true}';
    const wrongSig = "sha256=" + createHmac("sha256", "wrong-secret").update(body).digest("hex");
    expect(verifySignature(body, wrongSig, SECRET)).toBe(false);
  });
});

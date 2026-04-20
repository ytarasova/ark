/**
 * Tests for ACP (Agent Client Protocol): JSON-RPC session management.
 */

import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { handleAcpRequest, type AcpRequest } from "../acp.js";
import { getApp } from "./test-helpers.js";

withTestContext();

function req(method: string, params?: Record<string, unknown>, id: number = 1): AcpRequest {
  return { jsonrpc: "2.0", method, params, id };
}

describe("handleAcpRequest", () => {
  it("session/create creates a new session", async () => {
    const resp = await handleAcpRequest(
      getApp(),
      req("session/create", {
        summary: "ACP test session",
        repo: "/tmp/test-repo",
        flow: "quick",
      }),
    );

    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBe(1);
    expect(resp.error).toBeUndefined();

    const result = resp.result as Record<string, unknown>;
    expect(result.sessionId).toMatch(/^s-/);
    expect(result.status).toBe("ready");

    // Verify it actually exists in the store
    const session = getApp().sessions.get(result.sessionId);
    expect(session).toBeTruthy();
    expect(session!.summary).toBe("ACP test session");
  });

  it("session/list returns sessions", async () => {
    getApp().sessions.create({ summary: "list test 1", repo: "." });
    getApp().sessions.create({ summary: "list test 2", repo: "." });

    const resp = await handleAcpRequest(getApp(), req("session/list", { limit: 10 }));

    expect(resp.error).toBeUndefined();
    const sessions = resp.result as Record<string, unknown>[];
    expect(sessions.length).toBeGreaterThanOrEqual(2);
  });

  it("session/get returns a specific session", async () => {
    const session = getApp().sessions.create({ summary: "get test", repo: "." });

    const resp = await handleAcpRequest(getApp(), req("session/get", { sessionId: session.id }));

    expect(resp.error).toBeUndefined();
    const result = resp.result as Record<string, unknown>;
    expect(result.id).toBe(session.id);
    expect(result.summary).toBe("get test");
  });

  it("returns method not found for unknown methods", async () => {
    const resp = await handleAcpRequest(getApp(), req("session/nonexistent"));

    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32601);
    expect(resp.error!.message).toContain("Method not found");
  });

  it("returns error for session/get with bad id", async () => {
    const resp = await handleAcpRequest(getApp(), req("session/get", { sessionId: "s-doesnotexist" }));

    // getSession returns undefined for missing sessions, which is a valid result
    expect(resp.error).toBeUndefined();
    expect(resp.result).toBeNull();
  });

  it("session/delete removes a session", async () => {
    const session = getApp().sessions.create({ summary: "delete test", repo: "." });

    const resp = await handleAcpRequest(getApp(), req("session/delete", { sessionId: session.id }));

    expect(resp.error).toBeUndefined();
    const result = resp.result as Record<string, unknown>;
    expect(result.ok).toBe(true);
  });
});

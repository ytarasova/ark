/**
 * Unit tests for the agent-sdk `ask_user` MCP handler.
 *
 * We test the pure `askUserHandler` (same function wired into the SDK tool)
 * so no MCP transport is required. The POST shape must match what the
 * conductor's /hooks/status passthrough expects.
 */

import { test, expect } from "bun:test";
import { askUserHandler, createAskUserMcpServer } from "../mcp-ask-user.js";

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function makeFakeFetch(calls: CapturedCall[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
}

test("ask_user posts a type=question payload to /hooks/status", async () => {
  const calls: CapturedCall[] = [];
  const result = await askUserHandler(
    { question: "Which database should I use?", context: "app currently uses sqlite" },
    {
      sessionId: "s-ask",
      conductorUrl: "http://conductor:19100",
      authToken: "tok-123",
      stage: "plan",
      fetchFn: makeFakeFetch(calls),
    },
  );

  expect(result.isError ?? false).toBe(false);
  expect(result.content[0].type).toBe("text");
  expect(result.content[0].text.toLowerCase()).toContain("question sent to user");

  expect(calls).toHaveLength(1);
  const call = calls[0];
  expect(call.url).toBe("http://conductor:19100/hooks/status?session=s-ask");
  expect(call.init?.method).toBe("POST");

  const headers = call.init?.headers as Record<string, string>;
  expect(headers["Content-Type"]).toBe("application/json");
  expect(headers["Authorization"]).toBe("Bearer tok-123");

  const body = JSON.parse(String(call.init?.body));
  expect(body.type).toBe("question");
  expect(body.sessionId).toBe("s-ask");
  expect(body.stage).toBe("plan");
  expect(body.message).toBe("Which database should I use?");
  expect(body.context).toBe("app currently uses sqlite");
  expect(body.source).toBe("agent-sdk-ask-user");
  expect(typeof body.timestamp).toBe("string");
});

test("ask_user omits Authorization header when no authToken is set", async () => {
  const calls: CapturedCall[] = [];
  await askUserHandler(
    { question: "ok?" },
    { sessionId: "s-noauth", conductorUrl: "http://c:19100", stage: "", fetchFn: makeFakeFetch(calls) },
  );

  expect(calls).toHaveLength(1);
  const headers = calls[0].init?.headers as Record<string, string>;
  expect(headers["Authorization"]).toBeUndefined();

  const body = JSON.parse(String(calls[0].init?.body));
  expect(body.context).toBeNull();
});

test("ask_user returns a soft-failure message when fetch throws", async () => {
  const throwingFetch: typeof fetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;

  const result = await askUserHandler(
    { question: "ping?" },
    { sessionId: "s-err", conductorUrl: "http://c:19100", fetchFn: throwingFetch },
  );
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("network down");
});

test("ask_user is a no-op when conductorUrl is not provided", async () => {
  const calls: CapturedCall[] = [];
  const result = await askUserHandler(
    { question: "still works?" },
    { sessionId: "s-no-url", fetchFn: makeFakeFetch(calls) },
  );
  expect(calls).toHaveLength(0);
  expect(result.content[0].text.toLowerCase()).toContain("conductor unreachable");
});

test("createAskUserMcpServer returns an SDK-compatible config with the tool registered", () => {
  const server = createAskUserMcpServer({
    sessionId: "s-x",
    conductorUrl: "http://c:19100",
  });
  // The SDK returns an `McpSdkServerConfigWithInstance` with `type: "sdk"` and
  // a live MCP server instance attached. We're just asserting it's the right
  // shape; the handler contract is covered by the direct-handler tests above.
  const cfg = server as unknown as { type?: string; name?: string; instance?: unknown };
  expect(cfg.type).toBe("sdk");
  expect(cfg.name).toBe("ark-ask-user");
  expect(cfg.instance).toBeDefined();
});

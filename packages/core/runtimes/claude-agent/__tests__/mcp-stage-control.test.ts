/**
 * Unit tests for the `complete_stage` MCP handler.
 *
 * We test the pure `completeStageHandler` so no MCP transport is required.
 * The Stop-hook gate that consumes the flag this handler flips is covered
 * separately in `stop-hook-gate.test.ts`.
 */

import { test, expect } from "bun:test";
import { completeStageHandler, createStageControlMcpServer } from "../mcp-stage-control.js";

test("complete_stage invokes onCompleteStage with the reason argument", async () => {
  let seen: string | undefined = "<unset>";
  const result = await completeStageHandler(
    { reason: "verify stage: all unit tests passing, lint clean" },
    { onCompleteStage: (r) => (seen = r) },
  );

  expect(seen).toBe("verify stage: all unit tests passing, lint clean");
  expect(result.isError ?? false).toBe(false);
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  expect(result.content[0].text.toLowerCase()).toContain("stage marked complete");
});

test("complete_stage with no reason still fires the callback with undefined", async () => {
  const calls: Array<string | undefined> = [];
  const result = await completeStageHandler({}, { onCompleteStage: (r) => calls.push(r) });

  expect(calls).toEqual([undefined]);
  expect(result.isError ?? false).toBe(false);
  expect(result.content[0].text.toLowerCase()).toContain("stage marked complete");
});

test("complete_stage surfaces success even when onCompleteStage throws", async () => {
  // The launcher's onCompleteStage is a tiny local mutation; if it throws we
  // still want the tool call to succeed so the agent gets a coherent result.
  const result = await completeStageHandler(
    { reason: "done" },
    {
      onCompleteStage: () => {
        throw new Error("launcher gone");
      },
    },
  );

  expect(result.isError ?? false).toBe(false);
  expect(result.content[0].text.toLowerCase()).toContain("stage marked complete");
});

test("createStageControlMcpServer returns an SDK-compatible config with the tool registered", () => {
  const server = createStageControlMcpServer({ onCompleteStage: () => {} });
  // The SDK returns an `McpSdkServerConfigWithInstance` with `type: "sdk"` and
  // a live MCP server instance attached. We assert the shape; handler contract
  // is covered by the direct-handler tests above.
  const cfg = server as unknown as { type?: string; name?: string; instance?: unknown };
  expect(cfg.type).toBe("sdk");
  expect(cfg.name).toBe("ark-stage-control");
  expect(cfg.instance).toBeDefined();
});

/**
 * sage/* RPC handler tests -- happy path + error path.
 *
 * Uses a temp `file://` fixture so fetchAnalysis doesn't hit the network.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerSageHandlers } from "../sage.js";
import { createRequest, ErrorCodes, type JsonRpcError, type JsonRpcResponse } from "../../../protocol/types.js";

let app: AppContext;
let router: Router;
let fixturePath: string;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();

  // Materialise a minimal sage analysis fixture the handler can fetch via
  // file:// -- the in-memory analysis has one plan stream with two tasks.
  const fixtureDir = join(app.config.arkDir, "fixtures");
  mkdirSync(fixtureDir, { recursive: true });
  fixturePath = join(fixtureDir, "TEST-1.json");
  const analysis = {
    jira_id: "TEST-1",
    summary: "Test ticket",
    plan_streams: [
      {
        repo: "demo",
        branch: "main",
        tasks: [{ title: "add button" }, { title: "wire it up" }],
      },
    ],
  };
  writeFileSync(fixturePath, JSON.stringify(analysis), "utf-8");
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(() => {
  router = new Router();
  registerSageHandlers(router, app);
});

function ok(res: unknown): Record<string, any> {
  return (res as JsonRpcResponse).result as Record<string, any>;
}

describe("sage/context", () => {
  it("fetches a file:// analysis and returns structured metadata", async () => {
    const res = ok(
      await router.dispatch(
        createRequest(1, "sage/context", {
          analysisId: "TEST-1",
          sageUrl: `file://${fixturePath}`,
        }),
      ),
    );
    expect(res.analysisId).toBe("TEST-1");
    expect(res.streamCount).toBe(1);
    expect(res.taskCount).toBe(2);
    expect(res.streams[0].repo).toBe("demo");
    expect(res.streams[0].tasks.length).toBe(2);
  });

  it("returns INVALID_PARAMS when the analysis file is missing", async () => {
    const res = (await router.dispatch(
      createRequest(1, "sage/context", {
        analysisId: "DOES-NOT-EXIST",
        sageUrl: `file:///tmp/ark-sage-nope-${Date.now()}.json`,
      }),
    )) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(res.error?.message).toMatch(/failed to fetch/i);
  });

  it("requires analysisId", async () => {
    const res = (await router.dispatch(createRequest(1, "sage/context", {}))) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.INVALID_PARAMS);
  });
});

/**
 * sage/* RPC handler tests -- happy path + error path.
 *
 * Uses a temp `file://` fixture so fetchAnalysis doesn't hit the network.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, statSync, readFileSync } from "fs";
import { join } from "path";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerSageHandlers } from "../sage.js";
import { createRequest, ErrorCodes, type JsonRpcError, type JsonRpcResponse } from "../../../protocol/types.js";
import type { TenantContext } from "../../../core/auth/context.js";

let app: AppContext;
let router: Router;
let fixturePath: string;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();

  // Materialise a minimal sage analysis fixture the handler can fetch via
  // file:// -- the in-memory analysis has one plan stream with two tasks.
  const fixtureDir = join(app.config.dirs.ark, "fixtures");
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

// ── P1-5: sage/analyze writes tenant-segmented analysis JSON ───────────────
//
// Two tenants hitting the same `jira_id` must end up with distinct files on
// disk. The flow dispatch itself may fail in tests (no "from-sage-analysis"
// flow registered), but the analysis-materialisation step runs before the
// dispatch call, so the file presence is independent of dispatch success.

describe("sage/analyze tenant segmentation (P1-5)", () => {
  function ctxFor(tenantId: string): TenantContext {
    return { tenantId, userId: `user-${tenantId}`, role: "admin", isAdmin: true };
  }

  it("writes the analysis JSON to a tenant-scoped path with 0o600 perms", async () => {
    // Dispatch sage/analyze under two different tenants. Both use the same
    // jira_id; without tenant segmentation they'd clobber each other.
    const fixtureA = join(app.config.dirs.ark, "fixtures", "TEST-SHARED-A.json");
    const fixtureB = join(app.config.dirs.ark, "fixtures", "TEST-SHARED-B.json");
    // Same jira_id on both fixtures -- this is the whole point of the test.
    writeFileSync(
      fixtureA,
      JSON.stringify({
        jira_id: "SHARED-1",
        summary: "tenant a version",
        plan_streams: [{ repo: "repo-a", branch: "main", tasks: [{ title: "t-a" }] }],
      }),
      "utf-8",
    );
    writeFileSync(
      fixtureB,
      JSON.stringify({
        jira_id: "SHARED-1",
        summary: "tenant b version",
        plan_streams: [{ repo: "repo-b", branch: "main", tasks: [{ title: "t-b" }] }],
      }),
      "utf-8",
    );

    // Fire both requests. sessionLifecycle.start may throw if the
    // from-sage-analysis flow isn't registered in the test profile -- that's
    // fine, we're only asserting on the analysis-file side effect which
    // happens *before* the dispatch call.
    await router.dispatch(
      createRequest(1, "sage/analyze", { analysisId: "SHARED-1", sageUrl: `file://${fixtureA}` }),
      undefined,
      ctxFor("tenant-a"),
    );
    await router.dispatch(
      createRequest(2, "sage/analyze", { analysisId: "SHARED-1", sageUrl: `file://${fixtureB}` }),
      undefined,
      ctxFor("tenant-b"),
    );

    const pathA = join(app.config.dirs.ark, "sage", "tenant-a", "SHARED-1.analysis.json");
    const pathB = join(app.config.dirs.ark, "sage", "tenant-b", "SHARED-1.analysis.json");
    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);

    // Contents must differ -- each tenant sees its own analysis.
    const contentA = JSON.parse(readFileSync(pathA, "utf-8")) as { summary?: string };
    const contentB = JSON.parse(readFileSync(pathB, "utf-8")) as { summary?: string };
    expect(contentA.summary).toBe("tenant a version");
    expect(contentB.summary).toBe("tenant b version");

    // Perms: file must be 0o600 (owner read/write only). Skip this assert on
    // platforms where the FS doesn't honour mode bits (e.g. some container
    // overlays), but on macOS/Linux tmp this holds.
    const modeA = statSync(pathA).mode & 0o777;
    const modeB = statSync(pathB).mode & 0o777;
    expect(modeA).toBe(0o600);
    expect(modeB).toBe(0o600);
  });
});

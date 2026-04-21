import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../app.js";
import { buildDeployment } from "../deployment.js";
import { LocalBinaryExecutor } from "../executor/local.js";
import { LocalRepoStorage } from "../storage/local-fs.js";
import { AllowAllPolicy } from "../policy/allow-all.js";
import { StderrObservability } from "../observability/stderr.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

describe("Deployment factory -- local mode wiring", async () => {
  it("populates every seam with a local implementation", () => {
    const d = buildDeployment(app);
    expect(d.mode).toBe("local");
    expect(d.storeBackend).toBe("sqlite");
    expect(d.vendorResolver).toBeDefined();
    expect(d.executor).toBeInstanceOf(LocalBinaryExecutor);
    expect(d.storage).toBeInstanceOf(LocalRepoStorage);
    expect(d.policy).toBeInstanceOf(AllowAllPolicy);
    expect(d.observability).toBeInstanceOf(StderrObservability);
  });

  it("storage hands out a workdir under arkDir", async () => {
    const d = buildDeployment(app);
    const wd = await d.storage.workdirFor({ tenant_id: "t1", repo_id: "r1", run_id: "run-test-1" });
    expect(wd.isLocal).toBe(true);
    expect(wd.absolutePath).toContain("code-intel");
    expect(wd.absolutePath.endsWith("run-test-1")).toBe(true);
    await wd.release();
  });

  it("storage round-trips an artifact by id", async () => {
    const d = buildDeployment(app);
    const written = await d.storage.writeArtifact({ run_id: "run-art-1", name: "syft", data: "hello" });
    expect(written.id).toContain("run-art-1");
    expect(written.uri.startsWith("file://")).toBe(true);
    const read = await d.storage.readArtifact(written.id);
    expect(read.toString("utf-8")).toBe("hello");
  });

  it("policy allows reads + writes by default", () => {
    const d = buildDeployment(app);
    const ctx = { tenant_id: "t1" } as never;
    const subj = { kind: "file" as const, id: "f1" };
    expect(d.policy.allowRead(ctx, subj).allowed).toBe(true);
    expect(d.policy.allowWrite(ctx, subj).allowed).toBe(true);
    expect(d.policy.redact(ctx, subj, { secret: "x" })).toEqual({ secret: "x" });
  });

  it("observability span lifecycle does not throw", () => {
    const d = buildDeployment(app);
    const span = d.observability.startSpan("test.span", { tenant_id: "t1" });
    span.setAttribute("k", "v");
    span.end({ rows: 5 });
    d.observability.counter("test.counter", 1);
    d.observability.event("test.event");
  });
});

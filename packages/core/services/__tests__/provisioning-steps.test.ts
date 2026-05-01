/**
 * provisionStep tests. Cover the surfaces a session-failure post-mortem
 * actually relies on: structured events with status/duration/attempts,
 * retry-on-transient with backoff, error chain depth, and the
 * ProvisionStepError wrapper.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../app.js";
import { provisionStep, ProvisionStepError } from "../provisioning-steps.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

async function makeSession(): Promise<string> {
  const s = await app.sessions.create({ summary: "step test", flow: "bare" });
  return s.id;
}

async function readSteps(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const events = await app.events.list(sessionId);
  return events
    .filter((e: { type: string }) => e.type === "provisioning_step")
    .map((e: { data: Record<string, unknown> }) => e.data);
}

describe("provisionStep", () => {
  test("emits started + ok events on a happy-path step", async () => {
    const sid = await makeSession();
    const result = await provisionStep(app, sid, "happy", async () => 42);
    expect(result).toBe(42);
    const steps = await readSteps(sid);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ step: "happy", status: "started" });
    expect(steps[1]).toMatchObject({ step: "happy", status: "ok", attempts: 1 });
    expect(typeof steps[1].durationMs).toBe("number");
  });

  test("emits failed event with errorChain on non-transient error", async () => {
    const sid = await makeSession();
    const e = new Error("boom");
    await expect(
      provisionStep(app, sid, "explode", async () => {
        throw e;
      }),
    ).rejects.toBeInstanceOf(ProvisionStepError);
    const steps = await readSteps(sid);
    const failed = steps.find((s) => s.status === "failed");
    expect(failed).toBeDefined();
    expect(failed!.step).toBe("explode");
    expect(failed!.attempts).toBe(1);
    expect(Array.isArray(failed!.errorChain)).toBe(true);
    const chain = failed!.errorChain as Array<{ message?: string }>;
    expect(chain[0]?.message).toBe("boom");
  });

  test("ProvisionStepError carries the step name and the original cause", async () => {
    const sid = await makeSession();
    const original = new Error("inner");
    try {
      await provisionStep(app, sid, "named", async () => {
        throw original;
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ProvisionStepError);
      const pe = err as ProvisionStepError;
      expect(pe.step).toBe("named");
      expect(pe.message).toContain("named");
      expect(pe.message).toContain("inner");
      expect((pe as { cause?: unknown }).cause).toBe(original);
    }
  });

  test("retries on transient errors and reports attempts on success", async () => {
    const sid = await makeSession();
    let calls = 0;
    const result = await provisionStep(
      app,
      sid,
      "flaky",
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("ECONNRESET while reading");
        return "third-time-lucky";
      },
      { retries: 3, retryBackoffMs: 1 },
    );
    expect(result).toBe("third-time-lucky");
    expect(calls).toBe(3);
    const steps = await readSteps(sid);
    const ok = steps.find((s) => s.status === "ok");
    expect(ok).toBeDefined();
    expect(ok!.attempts).toBe(3);
    const retries = steps.filter((s) => s.status === "retrying");
    expect(retries.length).toBe(2);
  });

  test("stops retrying on non-transient errors", async () => {
    const sid = await makeSession();
    let calls = 0;
    await expect(
      provisionStep(
        app,
        sid,
        "permadead",
        async () => {
          calls += 1;
          throw new Error("type error: x is undefined");
        },
        { retries: 5, retryBackoffMs: 1 },
      ),
    ).rejects.toBeInstanceOf(ProvisionStepError);
    expect(calls).toBe(1);
  });

  test("custom isTransient controls retry classification", async () => {
    const sid = await makeSession();
    let calls = 0;
    const result = await provisionStep(
      app,
      sid,
      "custom-transient",
      async () => {
        calls += 1;
        if (calls < 2) throw new Error("flux capacitor jammed");
        return "ok";
      },
      {
        retries: 1,
        retryBackoffMs: 1,
        isTransient: (e) => /flux capacitor/.test((e as Error).message),
      },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  test("context fields are echoed onto every event for the step", async () => {
    const sid = await makeSession();
    await provisionStep(app, sid, "ctx", async () => "ok", {
      context: { compute: "ec2-test", instanceId: "i-deadbeef" },
    });
    const steps = await readSteps(sid);
    for (const s of steps) {
      expect(s.compute).toBe("ec2-test");
      expect(s.instanceId).toBe("i-deadbeef");
    }
  });
});

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { fanOut, checkAutoJoin } from "../services/fork-join.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

describe("auto-join", async () => {
  test("parent advances when all children complete", async () => {
    const parent = await app.sessions.create({ summary: "Parent", flow: "fan-out" });
    await app.sessions.update(parent.id, { stage: "execute", status: "running" });

    const result = await fanOut(app, parent.id, { tasks: [{ summary: "A" }, { summary: "B" }] });
    expect(result.ok).toBe(true);

    for (const childId of result.childIds!) {
      await app.sessions.update(childId, { status: "completed" });
    }

    const joinResult = await checkAutoJoin(app, result.childIds![0]);
    expect(joinResult).toBe(true);

    const updated = await app.sessions.get(parent.id);
    expect(updated!.status).not.toBe("waiting");
  });

  test("parent stays waiting when some children not done", async () => {
    const parent = await app.sessions.create({ summary: "Parent2", flow: "fan-out" });
    await app.sessions.update(parent.id, { stage: "execute", status: "running" });

    const result = await fanOut(app, parent.id, { tasks: [{ summary: "C" }, { summary: "D" }] });

    await app.sessions.update(result.childIds![0], { status: "completed" });

    const joinResult = await checkAutoJoin(app, result.childIds![0]);
    expect(joinResult).toBe(false);

    const updated = await app.sessions.get(parent.id);
    expect(updated!.status).toBe("waiting");
  });
});

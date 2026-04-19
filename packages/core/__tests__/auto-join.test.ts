import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { fanOut, checkAutoJoin } from "../services/session-orchestration.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});
afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

describe("auto-join", () => {
  test("parent advances when all children complete", async () => {
    const parent = app.sessions.create({ summary: "Parent", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "running" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "A" }, { summary: "B" }] });
    expect(result.ok).toBe(true);

    for (const childId of result.childIds!) {
      app.sessions.update(childId, { status: "completed" });
    }

    const joinResult = await checkAutoJoin(app, result.childIds![0]);
    expect(joinResult).toBe(true);

    const updated = app.sessions.get(parent.id);
    expect(updated!.status).not.toBe("waiting");
  });

  test("parent stays waiting when some children not done", async () => {
    const parent = app.sessions.create({ summary: "Parent2", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "running" });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "C" }, { summary: "D" }] });

    app.sessions.update(result.childIds![0], { status: "completed" });

    const joinResult = await checkAutoJoin(app, result.childIds![0]);
    expect(joinResult).toBe(false);

    const updated = app.sessions.get(parent.id);
    expect(updated!.status).toBe("waiting");
  });
});

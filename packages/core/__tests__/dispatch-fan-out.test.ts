import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { dispatch } from "../services/session-orchestration.js";

let app: AppContext;
beforeAll(async () => { app = AppContext.forTest(); await app.boot(); setApp(app); });
afterAll(async () => {
  // Give background child dispatches (fire-and-forget) time to settle before clearing app
  await Bun.sleep(200);
  await app?.shutdown();
  clearApp();
});

describe("dispatch fan_out stage", () => {
  test("fan_out stage creates children and sets parent to waiting", async () => {
    const parent = app.sessions.create({ summary: "Test fan-out", flow: "fan-out" });
    app.sessions.update(parent.id, { stage: "execute", status: "ready" });

    const result = await dispatch(parent.id);
    expect(result.ok).toBe(true);

    const updated = app.sessions.get(parent.id);
    expect(updated!.status).toBe("waiting");

    const children = app.sessions.getChildren(parent.id);
    expect(children.length).toBeGreaterThan(0);
  });
});

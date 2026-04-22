import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { dispatch } from "../services/dispatch.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  // Stop all sessions (kills tmux + claude processes via provider)
  if (app?.sessionService) await app.sessionService.stopAll();
  await app?.shutdown();
}, 30_000);

describe("dispatch fan_out stage", async () => {
  test("fan_out stage creates children and sets parent to waiting", async () => {
    const parent = await app.sessions.create({ summary: "Test fan-out", flow: "fan-out" });
    await app.sessions.update(parent.id, { stage: "execute", status: "ready" });

    const result = await dispatch(app, parent.id);
    expect(result.ok).toBe(true);

    const updated = await app.sessions.get(parent.id);
    expect(updated!.status).toBe("waiting");

    const children = await app.sessions.getChildren(parent.id);
    expect(children.length).toBeGreaterThan(0);

    // Clean up dispatched agents before test exits
    await app.sessionService.stopAll();
  }, 30_000);
});

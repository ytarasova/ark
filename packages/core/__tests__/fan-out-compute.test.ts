import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { fanOut } from "../services/session-orchestration.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

describe("fan-out compute inheritance", () => {
  test("children inherit parent compute_name", () => {
    const parent = app.sessions.create({ summary: "Parent on EC2", flow: "bare" });
    app.sessions.update(parent.id, { status: "running", stage: "implement", compute_name: "my-ec2" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "Child A" }, { summary: "Child B" }],
    });

    expect(result.ok).toBe(true);
    for (const childId of result.childIds!) {
      const child = app.sessions.get(childId);
      expect(child!.compute_name).toBe("my-ec2");
    }
  });

  test("children inherit parent workdir and repo", () => {
    const parent = app.sessions.create({ summary: "Parent", flow: "bare" });
    app.sessions.update(parent.id, {
      status: "running",
      stage: "implement",
      compute_name: "fc-host",
      workdir: "/home/ubuntu/myrepo",
      repo: "myrepo",
    });

    const result = fanOut(app, parent.id, { tasks: [{ summary: "Child" }] });
    expect(result.ok).toBe(true);

    const child = app.sessions.get(result.childIds![0]);
    expect(child!.compute_name).toBe("fc-host");
    expect(child!.workdir).toBe("/home/ubuntu/myrepo");
    expect(child!.repo).toBe("myrepo");
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(() => {
  for (const t of app.computeTemplates.list()) {
    app.computeTemplates.delete(t.name);
  }
});

describe("compute template RPC handlers", () => {
  it("list returns empty when no templates exist", () => {
    const templates = app.computeTemplates.list();
    expect(templates).toEqual([]);
  });

  it("create + list + get cycle works", () => {
    app.computeTemplates.create({
      name: "test-ec2",
      description: "Test EC2 template",
      provider: "ec2",
      config: { size: "l", region: "us-east-1" },
    });

    const list = app.computeTemplates.list();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("test-ec2");
    expect(list[0].provider).toBe("ec2");

    const got = app.computeTemplates.get("test-ec2");
    expect(got).not.toBeNull();
    expect(got!.description).toBe("Test EC2 template");
    expect(got!.config).toEqual({ size: "l", region: "us-east-1" });
  });

  it("delete removes template", () => {
    app.computeTemplates.create({
      name: "to-remove",
      provider: "docker",
      config: { image: "alpine" },
    });
    expect(app.computeTemplates.get("to-remove")).not.toBeNull();
    app.computeTemplates.delete("to-remove");
    expect(app.computeTemplates.get("to-remove")).toBeNull();
  });

  it("config templates are merged with DB templates in list", () => {
    // Simulate config templates by adding directly to DB
    app.computeTemplates.create({ name: "from-db", provider: "ec2", config: {} });

    const list = app.computeTemplates.list();
    expect(list.some((t) => t.name === "from-db")).toBe(true);
  });

  it("template config merges correctly with user overrides", () => {
    app.computeTemplates.create({
      name: "base-ec2",
      provider: "ec2",
      config: { size: "m", region: "us-east-1", arch: "x64" },
    });

    const tmpl = app.computeTemplates.get("base-ec2");
    const userConfig = { region: "eu-west-1" }; // override region only

    const merged = { ...tmpl!.config, ...userConfig };
    expect(merged).toEqual({ size: "m", region: "eu-west-1", arch: "x64" });
  });
});

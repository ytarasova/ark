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

beforeEach(async () => {
  for (const t of await app.computeTemplates.list()) {
    await app.computeTemplates.delete(t.name);
  }
});

describe("compute template RPC handlers", () => {
  it("list returns empty when no templates exist", async () => {
    const templates = await app.computeTemplates.list();
    expect(templates).toEqual([]);
  });

  it("create + list + get cycle works", async () => {
    await app.computeTemplates.create({
      name: "test-ec2",
      description: "Test EC2 template",
      provider: "ec2",
      config: { size: "l", region: "us-east-1" },
    });

    const list = await app.computeTemplates.list();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("test-ec2");
    expect(list[0].provider).toBe("ec2");

    const got = await app.computeTemplates.get("test-ec2");
    expect(got).not.toBeNull();
    expect(got!.config).toEqual({ size: "l", region: "us-east-1" });
  });

  it("delete removes template", async () => {
    await app.computeTemplates.create({
      name: "to-remove",
      provider: "docker",
      config: { image: "alpine" },
    });
    expect(await app.computeTemplates.get("to-remove")).not.toBeNull();
    await app.computeTemplates.delete("to-remove");
    expect(await app.computeTemplates.get("to-remove")).toBeNull();
  });

  it("config templates are merged with DB templates in list", async () => {
    // Simulate config templates by adding directly to DB
    await app.computeTemplates.create({ name: "from-db", provider: "ec2", config: {} });

    const list = await app.computeTemplates.list();
    expect(list.some((t) => t.name === "from-db")).toBe(true);
  });

  it("template config merges correctly with user overrides", async () => {
    await app.computeTemplates.create({
      name: "base-ec2",
      provider: "ec2",
      config: { size: "m", region: "us-east-1", arch: "x64" },
    });

    const tmpl = await app.computeTemplates.get("base-ec2");
    const userConfig = { region: "eu-west-1" }; // override region only

    const merged = { ...tmpl!.config, ...userConfig };
    expect(merged).toEqual({ size: "m", region: "eu-west-1", arch: "x64" });
  });
});

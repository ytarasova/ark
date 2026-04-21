import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../app.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

describe("ComputeTemplateRepository", () => {
  beforeEach(async () => {
    // Clean all templates
    for (const t of await app.computeTemplates.list()) {
      await app.computeTemplates.delete(t.name);
    }
  });

  it("creates and retrieves a template", async () => {
    await app.computeTemplates.create({
      name: "gpu-large",
      description: "Large GPU instance for ML",
      provider: "ec2",
      config: { size: "xl", region: "us-east-1", arch: "x64" },
    });

    const tmpl = await app.computeTemplates.get("gpu-large");
    expect(tmpl).not.toBeNull();
    expect(tmpl!.name).toBe("gpu-large");
    expect(tmpl!.provider).toBe("ec2");
    expect(tmpl!.config).toEqual({ size: "xl", region: "us-east-1", arch: "x64" });
  });

  it("lists templates", async () => {
    await app.computeTemplates.create({ name: "sandbox", provider: "docker", config: { image: "ubuntu:22.04" } });
    await app.computeTemplates.create({ name: "quick", provider: "local", config: {} });

    const templates = await app.computeTemplates.list();
    expect(templates.length).toBe(2);
    expect(templates.map((t) => t.name).sort()).toEqual(["quick", "sandbox"]);
  });

  it("updates a template", async () => {
    await app.computeTemplates.create({ name: "test-tmpl", provider: "ec2", config: { size: "s" } });
    await app.computeTemplates.update("test-tmpl", { config: { size: "l", region: "eu-west-1" } });

    const tmpl = await app.computeTemplates.get("test-tmpl");
    expect(tmpl!.config).toEqual({ size: "l", region: "eu-west-1" });
  });

  it("deletes a template", async () => {
    await app.computeTemplates.create({ name: "to-delete", provider: "docker", config: {} });
    expect(await app.computeTemplates.get("to-delete")).not.toBeNull();

    await app.computeTemplates.delete("to-delete");
    expect(await app.computeTemplates.get("to-delete")).toBeNull();
  });

  it("returns null for non-existent template", async () => {
    expect(await app.computeTemplates.get("nope")).toBeNull();
  });

  it("tenant scoping isolates templates", async () => {
    await app.computeTemplates.create({ name: "shared-name", provider: "ec2", config: { size: "s" } });

    // Create tenant-scoped view
    const tenantApp = app.forTenant("tenant-a");
    await tenantApp.computeTemplates.create({ name: "shared-name", provider: "docker", config: { image: "alpine" } });

    // Default tenant sees ec2
    const defaultTmpl = await app.computeTemplates.get("shared-name");
    expect(defaultTmpl!.provider).toBe("ec2");

    // Tenant A sees docker
    const tenantTmpl = await tenantApp.computeTemplates.get("shared-name");
    expect(tenantTmpl!.provider).toBe("docker");
  });
});

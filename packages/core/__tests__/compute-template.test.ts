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
  beforeEach(() => {
    // Clean all templates
    for (const t of app.computeTemplates.list()) {
      app.computeTemplates.delete(t.name);
    }
  });

  it("creates and retrieves a template", () => {
    app.computeTemplates.create({
      name: "gpu-large",
      description: "Large GPU instance for ML",
      provider: "ec2",
      config: { size: "xl", region: "us-east-1", arch: "x64" },
    });

    const tmpl = app.computeTemplates.get("gpu-large");
    expect(tmpl).not.toBeNull();
    expect(tmpl!.name).toBe("gpu-large");
    expect(tmpl!.description).toBe("Large GPU instance for ML");
    expect(tmpl!.provider).toBe("ec2");
    expect(tmpl!.config).toEqual({ size: "xl", region: "us-east-1", arch: "x64" });
  });

  it("lists templates", () => {
    app.computeTemplates.create({ name: "sandbox", provider: "docker", config: { image: "ubuntu:22.04" } });
    app.computeTemplates.create({ name: "quick", provider: "local", config: {} });

    const templates = app.computeTemplates.list();
    expect(templates.length).toBe(2);
    expect(templates.map((t) => t.name).sort()).toEqual(["quick", "sandbox"]);
  });

  it("updates a template", () => {
    app.computeTemplates.create({ name: "test-tmpl", provider: "ec2", config: { size: "s" } });
    app.computeTemplates.update("test-tmpl", { config: { size: "l", region: "eu-west-1" } });

    const tmpl = app.computeTemplates.get("test-tmpl");
    expect(tmpl!.config).toEqual({ size: "l", region: "eu-west-1" });
  });

  it("deletes a template", () => {
    app.computeTemplates.create({ name: "to-delete", provider: "docker", config: {} });
    expect(app.computeTemplates.get("to-delete")).not.toBeNull();

    app.computeTemplates.delete("to-delete");
    expect(app.computeTemplates.get("to-delete")).toBeNull();
  });

  it("returns null for non-existent template", () => {
    expect(app.computeTemplates.get("nope")).toBeNull();
  });

  it("tenant scoping isolates templates", () => {
    app.computeTemplates.create({ name: "shared-name", provider: "ec2", config: { size: "s" } });

    // Create tenant-scoped view
    const tenantApp = app.forTenant("tenant-a");
    tenantApp.computeTemplates.create({ name: "shared-name", provider: "docker", config: { image: "alpine" } });

    // Default tenant sees ec2
    const defaultTmpl = app.computeTemplates.get("shared-name");
    expect(defaultTmpl!.provider).toBe("ec2");

    // Tenant A sees docker
    const tenantTmpl = tenantApp.computeTemplates.get("shared-name");
    expect(tenantTmpl!.provider).toBe("docker");
  });
});

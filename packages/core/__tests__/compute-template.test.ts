import { legacyProviderLabel as providerOf } from "./_util/legacy-provider-label.js";
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
      compute: "ec2",
      isolation: "direct",
      config: { size: "xl", region: "us-east-1", arch: "x64" },
    });

    const tmpl = await app.computeTemplates.get("gpu-large");
    expect(tmpl).not.toBeNull();
    expect(tmpl!.name).toBe("gpu-large");
    expect(tmpl!.compute).toBe("ec2");
    expect(tmpl!.isolation).toBe("direct");
    expect(tmpl!.config).toEqual({ size: "xl", region: "us-east-1", arch: "x64" });
  });

  it("lists templates", async () => {
    await app.computeTemplates.create({
      name: "sandbox",
      compute: "local",
      isolation: "docker",
      config: { image: "ubuntu:22.04" },
    });
    await app.computeTemplates.create({ name: "quick", compute: "local", isolation: "direct", config: {} });

    const templates = await app.computeTemplates.list();
    expect(templates.length).toBe(2);
    expect(templates.map((t) => t.name).sort()).toEqual(["quick", "sandbox"]);
  });

  it("updates a template", async () => {
    await app.computeTemplates.create({
      name: "test-tmpl",
      compute: "ec2",
      isolation: "direct",
      config: { size: "s" },
    });
    await app.computeTemplates.update("test-tmpl", { config: { size: "l", region: "eu-west-1" } });

    const tmpl = await app.computeTemplates.get("test-tmpl");
    expect(tmpl!.config).toEqual({ size: "l", region: "eu-west-1" });
  });

  it("deletes a template", async () => {
    await app.computeTemplates.create({ name: "to-delete", compute: "local", isolation: "docker", config: {} });
    expect(await app.computeTemplates.get("to-delete")).not.toBeNull();

    await app.computeTemplates.delete("to-delete");
    expect(await app.computeTemplates.get("to-delete")).toBeNull();
  });

  it("returns null for non-existent template", async () => {
    expect(await app.computeTemplates.get("nope")).toBeNull();
  });

  it("tenant scoping isolates templates", async () => {
    // Templates materialize into the unified `compute` table, which still has
    // a single-column `name` primary key (see drizzle/schema/{sqlite,postgres}.ts).
    // True same-name-per-tenant isolation needs migration 011 to flip that to
    // a `(name, tenant_id)` composite PK -- tracked separately. Until then,
    // this test just asserts that tenant-scoped reads don't leak across
    // tenants even when the raw `compute` row exists under the default tenant.
    await app.computeTemplates.create({
      name: "default-only-template",
      compute: "ec2",
      isolation: "direct",
      config: { size: "s" },
    });
    const tenantApp = app.forTenant("tenant-a");
    await tenantApp.computeTemplates.create({
      name: "tenant-a-only-template",
      compute: "local",
      isolation: "docker",
      config: { image: "alpine" },
    });

    const defaultTmpl = await app.computeTemplates.get("default-only-template");
    expect(defaultTmpl!.compute).toBe("ec2");
    expect(defaultTmpl!.isolation).toBe("direct");
    expect(await tenantApp.computeTemplates.get("default-only-template")).toBeNull();

    const tenantTmpl = await tenantApp.computeTemplates.get("tenant-a-only-template");
    expect(tenantTmpl!.compute).toBe("local");
    expect(tenantTmpl!.isolation).toBe("docker");
    expect(await app.computeTemplates.get("tenant-a-only-template")).toBeNull();
  });
});

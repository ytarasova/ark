/**
 * AppMode tests.
 *
 * Verify the DI-composition-time selection between `LocalAppMode` and
 * `HostedAppMode` based on `config.database.url`, plus the capability presence
 * contract: local mode populates every capability, hosted mode nulls them all.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { buildAppMode, buildLocalAppMode, buildHostedAppMode } from "../modes/app-mode.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

describe("buildAppMode", () => {
  it("returns LocalAppMode when no database url is configured", () => {
    const mode = buildAppMode({ database: { url: undefined } } as any);
    expect(mode.kind).toBe("local");
    expect(mode.fsCapability).not.toBeNull();
    expect(mode.knowledgeCapability).toBeNull(); // no app arg -> knowledge needs app
    expect(mode.mcpDirCapability).not.toBeNull();
    expect(mode.repoMapCapability).not.toBeNull();
    expect(mode.ftsRebuildCapability).toBeNull();
    expect(mode.hostCommandCapability).not.toBeNull();
  });

  it("returns HostedAppMode when a database url is configured", () => {
    const mode = buildAppMode({ database: { url: "postgres://fake/ark" } } as any);
    expect(mode.kind).toBe("hosted");
    expect(mode.fsCapability).toBeNull();
    expect(mode.knowledgeCapability).toBeNull();
    expect(mode.mcpDirCapability).toBeNull();
    expect(mode.repoMapCapability).toBeNull();
    expect(mode.ftsRebuildCapability).toBeNull();
    expect(mode.hostCommandCapability).toBeNull();
  });

  it("reads the legacy flat databaseUrl field as a fallback", () => {
    const mode = buildAppMode({ databaseUrl: "sqlite://legacy" } as any);
    expect(mode.kind).toBe("hosted");
  });

  it("treats empty string databaseUrl as local", () => {
    const mode = buildAppMode({ databaseUrl: "" } as any);
    expect(mode.kind).toBe("local");
  });
});

describe("buildLocalAppMode(app)", () => {
  it("populates knowledge + fts-rebuild capabilities when an app is provided", () => {
    const mode = buildLocalAppMode(app);
    expect(mode.knowledgeCapability).not.toBeNull();
    expect(mode.ftsRebuildCapability).not.toBeNull();
  });
});

describe("buildHostedAppMode", () => {
  it("nulls every capability", () => {
    const mode = buildHostedAppMode();
    expect(mode.kind).toBe("hosted");
    expect(mode.fsCapability).toBeNull();
    expect(mode.knowledgeCapability).toBeNull();
    expect(mode.mcpDirCapability).toBeNull();
    expect(mode.repoMapCapability).toBeNull();
    expect(mode.ftsRebuildCapability).toBeNull();
    expect(mode.hostCommandCapability).toBeNull();
  });
});

describe("app.mode (DI-registered)", () => {
  it("is resolvable after boot", () => {
    expect(app.mode.kind).toBe("local");
  });

  it("caches -- multiple reads return the same object", () => {
    const a = app.mode;
    const b = app.mode;
    expect(a).toBe(b);
  });
});

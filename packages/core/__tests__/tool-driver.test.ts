import { describe, it, expect } from "bun:test";
import { getToolDriver, listToolDrivers } from "../tools/registry.js";
import { ClaudeDriver } from "../tools/claude-driver.js";
import { GeminiDriver } from "../tools/gemini-driver.js";

describe("tool driver registry", () => {
  it("lists available drivers", () => {
    const drivers = listToolDrivers();
    expect(drivers).toContain("claude");
    expect(drivers).toContain("gemini");
  });

  it("defaults to claude", () => {
    const driver = getToolDriver(null);
    expect(driver.name).toBe("claude");
  });

  it("returns gemini driver", () => {
    const driver = getToolDriver("gemini");
    expect(driver.name).toBe("gemini");
  });
});

describe("ClaudeDriver", () => {
  const driver = new ClaudeDriver();

  it("resolves model names", () => {
    expect(driver.resolveModel("opus")).toBe("claude-opus-4-6");
    expect(driver.resolveModel("sonnet")).toBe("claude-sonnet-4-6");
    expect(driver.resolveModel("custom-id")).toBe("custom-id");
  });

  it("builds CLI args", () => {
    const args = driver.buildArgs({
      model: "sonnet",
      maxTurns: 50,
      systemPrompt: "You are a helper",
      permissionMode: "bypassPermissions",
    });
    expect(args[0]).toBe("claude");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-6");
    expect(args).toContain("--max-turns");
    expect(args).toContain("50");
    expect(args).toContain("--dangerously-skip-permissions");
  });
});

describe("GeminiDriver", () => {
  const driver = new GeminiDriver();

  it("resolves model names", () => {
    expect(driver.resolveModel("pro")).toBe("gemini-2.5-pro");
    expect(driver.resolveModel("flash")).toBe("gemini-2.5-flash");
    expect(driver.resolveModel("custom")).toBe("custom");
  });

  it("builds CLI args", () => {
    const args = driver.buildArgs({
      model: "pro",
      systemPrompt: "You are a helper",
      permissionMode: "bypassPermissions",
    });
    expect(args[0]).toBe("gemini");
    expect(args).toContain("--model");
    expect(args).toContain("gemini-2.5-pro");
    expect(args).toContain("--yolo");
  });

  it("builds launcher script", () => {
    const result = driver.buildLauncher({
      toolArgs: ["gemini", "--model", "gemini-2.5-pro"],
      workdir: "/tmp/test",
    });
    expect(result.script).toContain("gemini");
    expect(result.script).toContain("/tmp/test");
    expect(result.sessionId).toBeDefined();
  });
});

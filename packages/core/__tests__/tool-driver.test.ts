import { describe, it, expect } from "bun:test";
import { getToolDriver, listToolDrivers } from "../tools/registry.js";
import { registerToolDriver } from "../tools/registry.js";
import { ClaudeDriver } from "../tools/claude-driver.js";
import { GeminiDriver } from "../tools/gemini-driver.js";
import type { ToolDriver } from "../tool-driver.js";

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

describe("tool driver registry advanced", () => {
  it("getToolDriver with unknown name falls back to claude", () => {
    const driver = getToolDriver("nonexistent-tool");
    expect(driver.name).toBe("claude");
  });

  it("registerToolDriver adds a custom driver", () => {
    const custom: ToolDriver = {
      name: "custom-ai",
      resolveModel: (s: string) => s,
      buildArgs: () => ["custom-ai", "--run"],
      buildLauncher: () => ({ script: "#!/bin/bash\ncustom-ai", sessionId: "test" }),
    };
    registerToolDriver(custom);
    const driver = getToolDriver("custom-ai");
    expect(driver.name).toBe("custom-ai");
    expect(driver.buildArgs({ model: "custom" })).toEqual(["custom-ai", "--run"]);
  });
});

describe("ClaudeDriver advanced", () => {
  const driver = new ClaudeDriver();

  it("builds minimal args (model only)", () => {
    const args = driver.buildArgs({ model: "haiku" });
    expect(args).toEqual(["claude", "--model", "claude-haiku-4-5-20251001"]);
  });

  it("builds args with all options", () => {
    const args = driver.buildArgs({
      model: "opus",
      maxTurns: 200,
      systemPrompt: "Be helpful",
      mcpConfigPath: "/tmp/mcp.json",
      permissionMode: "bypassPermissions",
      extraArgs: ["--verbose"],
    });
    expect(args).toContain("claude");
    expect(args).toContain("--model");
    expect(args).toContain("claude-opus-4-6");
    expect(args).toContain("--max-turns");
    expect(args).toContain("200");
    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("Be helpful");
    expect(args).toContain("--mcp-config");
    expect(args).toContain("/tmp/mcp.json");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--verbose");
  });

  it("does not add permission flag for normal mode", () => {
    const args = driver.buildArgs({ model: "sonnet", permissionMode: "normal" });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("passes through unknown model names unchanged", () => {
    expect(driver.resolveModel("claude-custom-model-123")).toBe("claude-custom-model-123");
  });
});

describe("GeminiDriver advanced", () => {
  const driver = new GeminiDriver();

  it("builds minimal args (model only)", () => {
    const args = driver.buildArgs({ model: "flash" });
    expect(args[0]).toBe("gemini");
    expect(args).toContain("gemini-2.5-flash");
  });

  it("does not add --yolo without bypass", () => {
    const args = driver.buildArgs({ model: "pro" });
    expect(args).not.toContain("--yolo");
  });

  it("adds --system-instruction for system prompt", () => {
    const args = driver.buildArgs({ model: "pro", systemPrompt: "You are a coder" });
    expect(args).toContain("--system-instruction");
    expect(args).toContain("You are a coder");
  });

  it("buildLauncher generates valid bash script", () => {
    const result = driver.buildLauncher({
      toolArgs: ["gemini", "--model", "gemini-2.5-pro", "--yolo"],
      workdir: "/home/user/project",
      env: { GEMINI_API_KEY: "test-key" },
    });
    expect(result.script).toContain("#!/usr/bin/env bash");
    expect(result.script).toContain("/home/user/project");
    expect(result.script).toContain("GEMINI_API_KEY");
    expect(result.script).toContain("gemini");
    expect(result.sessionId).toBeTruthy();
  });

  it("buildLauncher adds --resume flag with prevSessionId", () => {
    const result = driver.buildLauncher({
      toolArgs: ["gemini", "--model", "gemini-2.5-pro"],
      workdir: "/tmp",
      prevSessionId: "prev-123",
    });
    expect(result.script).toContain("--resume prev-123");
  });

  it("buildLauncher uses provided sessionId", () => {
    const result = driver.buildLauncher({
      toolArgs: ["gemini"],
      workdir: "/tmp",
      sessionId: "my-custom-id",
    });
    expect(result.sessionId).toBe("my-custom-id");
  });
});

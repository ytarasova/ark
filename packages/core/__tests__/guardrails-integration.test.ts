import { describe, it, expect } from "bun:test";
import { evaluateToolCall } from "../guardrails.js";

describe("guardrails integration", () => {
  it("evaluateToolCall blocks dangerous bash commands", () => {
    const result = evaluateToolCall("Bash", { command: "rm -rf /home" });
    expect(result.action).toBe("block");
    expect(result.rule).toBeDefined();
  });

  it("evaluateToolCall allows safe commands", () => {
    const result = evaluateToolCall("Bash", { command: "ls -la" });
    expect(result.action).toBe("allow");
  });

  it("evaluateToolCall warns on sensitive file access", () => {
    const result = evaluateToolCall("Read", { file_path: ".env" });
    expect(result.action).toBe("warn");
  });

  it("evaluateToolCall uses custom rules when provided", () => {
    const rules = [{ tool: "Bash", pattern: "npm publish", action: "block" as const }];
    const result = evaluateToolCall("Bash", { command: "npm publish" }, rules);
    expect(result.action).toBe("block");
  });
});

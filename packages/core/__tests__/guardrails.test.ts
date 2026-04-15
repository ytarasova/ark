/**
 * Tests for guardrails.ts — tool authorization rules.
 */

import { describe, it, expect } from "bun:test";
import { evaluateGuardrail, DEFAULT_RULES, type GuardrailRule } from "../session/guardrails.js";

describe("guardrails", () => {
  it("blocks dangerous bash commands", () => {
    const rules: GuardrailRule[] = [
      { tool: "Bash", pattern: "rm -rf /", action: "block" },
      { tool: "Bash", pattern: "DROP TABLE", action: "block" },
    ];

    expect(evaluateGuardrail(rules, "Bash", { command: "rm -rf /" })).toBe("block");
    expect(evaluateGuardrail(rules, "Bash", { command: "DROP TABLE users" })).toBe("block");
    expect(evaluateGuardrail(rules, "Bash", { command: "ls -la" })).toBe("allow");
    expect(evaluateGuardrail(rules, "Read", { file: "/etc/passwd" })).toBe("allow");
  });

  it("warns on sensitive file access", () => {
    const rules: GuardrailRule[] = [
      { tool: "Read", pattern: '\\.env"', action: "warn" },
      { tool: "Read", pattern: "credentials", action: "warn" },
    ];

    expect(evaluateGuardrail(rules, "Read", { file_path: ".env" })).toBe("warn");
    expect(evaluateGuardrail(rules, "Read", { file_path: "config/credentials.json" })).toBe("warn");
    expect(evaluateGuardrail(rules, "Read", { file_path: "src/app.ts" })).toBe("allow");
  });

  it("allows normal operations", () => {
    expect(evaluateGuardrail(DEFAULT_RULES, "Bash", { command: "ls -la" })).toBe("allow");
    expect(evaluateGuardrail(DEFAULT_RULES, "Bash", { command: "npm install" })).toBe("allow");
    expect(evaluateGuardrail(DEFAULT_RULES, "Read", { file_path: "src/index.ts" })).toBe("allow");
    expect(evaluateGuardrail(DEFAULT_RULES, "Write", { file_path: "src/index.ts" })).toBe("allow");
    expect(evaluateGuardrail(DEFAULT_RULES, "Glob", { pattern: "**/*.ts" })).toBe("allow");
  });

  it("handles invalid regex gracefully", () => {
    const rules: GuardrailRule[] = [
      { tool: "Bash", pattern: "[invalid(regex", action: "block" },
      { tool: "Bash", pattern: "rm -rf", action: "block" },
    ];

    // Invalid regex is skipped, second rule still matches
    expect(evaluateGuardrail(rules, "Bash", { command: "rm -rf /tmp" })).toBe("block");
    // Invalid regex doesn't cause crash
    expect(evaluateGuardrail(rules, "Bash", { command: "ls" })).toBe("allow");
  });

  it("DEFAULT_RULES blocks known dangerous patterns", () => {
    expect(evaluateGuardrail(DEFAULT_RULES, "Bash", { command: "rm -rf /home" })).toBe("block");
    expect(evaluateGuardrail(DEFAULT_RULES, "Bash", { command: "DROP TABLE users" })).toBe("block");
    expect(evaluateGuardrail(DEFAULT_RULES, "Bash", { command: "mkfs.ext4 /dev/sda1" })).toBe("block");
    expect(evaluateGuardrail(DEFAULT_RULES, "Bash", { command: "dd if=/dev/zero of=/dev/sda" })).toBe("block");
  });

  it("DEFAULT_RULES warns on sensitive files", () => {
    expect(evaluateGuardrail(DEFAULT_RULES, "Read", { file_path: "/app/.env" })).toBe("warn");
    expect(evaluateGuardrail(DEFAULT_RULES, "Read", { file_path: "credentials.json" })).toBe("warn");
    expect(evaluateGuardrail(DEFAULT_RULES, "Write", { file_path: "/app/.env" })).toBe("warn");
  });

  it("first matching rule wins", () => {
    const rules: GuardrailRule[] = [
      { tool: "Bash", pattern: "rm", action: "warn" },
      { tool: "Bash", pattern: "rm -rf", action: "block" },
    ];

    // First match wins - "warn" because "rm" matches first
    expect(evaluateGuardrail(rules, "Bash", { command: "rm -rf /tmp" })).toBe("warn");
  });
});

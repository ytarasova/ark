/**
 * Tests that extract<T>() returns the full params object (as designed)
 * and that handlers should only use the extracted fields.
 *
 * extract() validates required keys are present but does not strip extras.
 * Handlers must destructure only the fields they need and pass those
 * to downstream functions -- never pass the raw params object.
 */

import { describe, it, expect } from "bun:test";
import { extract } from "../validate.js";

describe("extract() field behavior", () => {
  it("returns only declared fields when no extras are present", () => {
    const params = { name: "test-skill", content: "hello" };
    const result = extract<{ name: string; content: string }>(params, ["name"]);
    expect(result.name).toBe("test-skill");
    expect(result.content).toBe("hello");
  });

  it("extra fields in params ARE accessible on the result (by design)", () => {
    const params = {
      name: "test-skill",
      content: "hello",
      malicious_field: "injected",
      __proto__: "bad",
    };
    const result = extract<{ name: string; content: string }>(params, ["name"]);
    // extract() returns the raw params object -- it does NOT strip extras
    // This is why handlers must destructure and pass only validated fields
    expect((result as Record<string, unknown>).malicious_field).toBe("injected");
  });

  it("validates required fields are present", () => {
    const params = { content: "hello" };
    expect(() => extract<{ name: string }>(params, ["name"])).toThrow("Missing required param: name");
  });

  it("allows undefined params to be caught", () => {
    expect(() => extract<{ name: string }>(undefined, ["name"])).toThrow("Missing params");
  });

  it("destructuring prevents extra fields from leaking", () => {
    const params = {
      name: "my-skill",
      content: "prompt text",
      scope: "global",
      evil: "should not leak",
    };
    // Simulate correct handler pattern: extract then destructure
    const { name, content, scope } = extract<{
      name: string;
      content?: string;
      scope?: string;
    }>(params, ["name"]);
    // Only the destructured fields are available
    const safeObj = { name, content, scope };
    expect(safeObj).toEqual({ name: "my-skill", content: "prompt text", scope: "global" });
    expect((safeObj as Record<string, unknown>).evil).toBeUndefined();
  });
});

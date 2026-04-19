/**
 * Schema tests for the RHF+zod migrations.
 *
 * These schemas drive both form validation and the post-submit payload
 * shape. Keeping a test on the zod definitions themselves prevents
 * regressions if someone edits a field type / trims a `.min()` by accident.
 */

import { describe, test, expect } from "bun:test";
import { NewComputeFormSchema } from "../components/compute/NewComputeForm.js";
import { NewSessionSchema } from "../components/NewSessionModal.js";

describe("NewComputeFormSchema", () => {
  test("accepts a minimal valid payload", () => {
    const result = NewComputeFormSchema.safeParse({
      name: "my-compute",
      compute: "local",
      runtime: "direct",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Optional fields default to empty strings so callers never see undefined.
      expect(result.data.size).toBe("");
      expect(result.data.region).toBe("");
      expect(result.data.aws_profile).toBe("");
    }
  });

  test("rejects missing name", () => {
    const result = NewComputeFormSchema.safeParse({ name: "", compute: "local", runtime: "direct" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/required/i);
    }
  });

  test("rejects blank compute kind", () => {
    const result = NewComputeFormSchema.safeParse({ name: "x", compute: "", runtime: "direct" });
    expect(result.success).toBe(false);
  });
});

describe("NewSessionSchema", () => {
  test("accepts a minimal valid payload", () => {
    const result = NewSessionSchema.safeParse({ summary: "Do the thing", repo: "." });
    expect(result.success).toBe(true);
  });

  test("trims summary and rejects empty after trim", () => {
    const result = NewSessionSchema.safeParse({ summary: "   ", repo: "." });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Describe the task");
    }
  });

  test("rejects empty repo", () => {
    const result = NewSessionSchema.safeParse({ summary: "hi", repo: "" });
    expect(result.success).toBe(false);
  });
});

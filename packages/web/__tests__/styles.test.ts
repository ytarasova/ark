/**
 * Tests for shared UI styles module.
 */

import { describe, it, expect } from "bun:test";
import { selectClassName } from "../src/components/ui/styles.js";

describe("selectClassName", () => {
  it("is a non-empty string", () => {
    expect(typeof selectClassName).toBe("string");
    expect(selectClassName.length).toBeGreaterThan(0);
  });

  it("contains core Tailwind classes for a styled select", () => {
    expect(selectClassName).toContain("rounded-md");
    expect(selectClassName).toContain("border");
    expect(selectClassName).toContain("text-sm");
    expect(selectClassName).toContain("appearance-none");
  });

  it("includes the custom SVG chevron background", () => {
    expect(selectClassName).toContain("bg-[url(");
    expect(selectClassName).toContain("bg-no-repeat");
  });
});

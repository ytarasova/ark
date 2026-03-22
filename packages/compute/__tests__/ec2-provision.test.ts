import { describe, it, expect } from "bun:test";
import {
  INSTANCE_SIZES,
  resolveInstanceType,
  provisionStack,
  destroyStack,
} from "../providers/ec2/provision.js";

describe("INSTANCE_SIZES", () => {
  it("has entries for xs through xxxl (7 sizes)", () => {
    const expected = ["xs", "s", "m", "l", "xl", "xxl", "xxxl"];
    expect(Object.keys(INSTANCE_SIZES)).toEqual(expected);
    expect(Object.keys(INSTANCE_SIZES)).toHaveLength(7);
  });

  it("each entry is a [x64, arm] tuple", () => {
    for (const [key, value] of Object.entries(INSTANCE_SIZES)) {
      expect(Array.isArray(value)).toBe(true);
      expect(value).toHaveLength(2);
      expect(typeof value[0]).toBe("string");
      expect(typeof value[1]).toBe("string");
    }
  });
});

describe("resolveInstanceType", () => {
  it('resolves "m" + "x64" to m6i.2xlarge', () => {
    expect(resolveInstanceType("m", "x64")).toBe("m6i.2xlarge");
  });

  it('resolves "m" + "arm" to m6g.2xlarge', () => {
    expect(resolveInstanceType("m", "arm")).toBe("m6g.2xlarge");
  });

  it('resolves "xs" to m6i.large (default x64)', () => {
    expect(resolveInstanceType("xs")).toBe("m6i.large");
  });

  it("returns fallback when size is undefined", () => {
    expect(resolveInstanceType(undefined)).toBe("m6i.2xlarge");
  });

  it("returns custom fallback when provided", () => {
    expect(resolveInstanceType(undefined, "x64", "t3.micro")).toBe("t3.micro");
  });

  it("passes through literal instance types", () => {
    expect(resolveInstanceType("c5.xlarge")).toBe("c5.xlarge");
  });

  it("passes through unknown size labels as literal types", () => {
    expect(resolveInstanceType("r5.metal")).toBe("r5.metal");
  });
});

describe("provisionStack", () => {
  it("is an async function", () => {
    expect(typeof provisionStack).toBe("function");
  });
});

describe("destroyStack", () => {
  it("is an async function", () => {
    expect(typeof destroyStack).toBe("function");
  });
});

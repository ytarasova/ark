import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parsePair, parseInputs, parseParams } from "../exec.js";

let tmpDir: string;
let recipePath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ark-exec-inputs-"));
  recipePath = join(tmpDir, "recipe.md");
  writeFileSync(recipePath, "# Recipe\n\nDo the thing.\n", "utf8");
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("parsePair", () => {
  it("splits on the first `=`", () => {
    expect(parsePair("foo=bar", "--x")).toEqual(["foo", "bar"]);
  });

  it("preserves `=` in the value", () => {
    expect(parsePair("recipe=a=b=c", "--x")).toEqual(["recipe", "a=b=c"]);
  });

  it("rejects missing `=`", () => {
    expect(() => parsePair("norecipe", "--input")).toThrow(/--input expects/);
  });

  it("rejects empty key", () => {
    expect(() => parsePair("=bar", "--input")).toThrow(/--input expects/);
  });
});

describe("parseInputs", () => {
  it("returns undefined when empty", () => {
    expect(parseInputs(undefined)).toBeUndefined();
    expect(parseInputs([])).toBeUndefined();
  });

  it("resolves relative paths and validates existence", () => {
    const out = parseInputs([`recipe=${recipePath}`]);
    expect(out).toEqual({ recipe: recipePath });
  });

  it("throws for missing file", () => {
    expect(() => parseInputs(["recipe=/no/such/file"])).toThrow(/file not found/);
  });

  it("collects multiple pairs", () => {
    const secondary = join(tmpDir, "notes.md");
    writeFileSync(secondary, "notes", "utf8");
    const out = parseInputs([`recipe=${recipePath}`, `notes=${secondary}`]);
    expect(out).toEqual({ recipe: recipePath, notes: secondary });
  });
});

describe("parseParams", () => {
  it("returns undefined when empty", () => {
    expect(parseParams(undefined)).toBeUndefined();
    expect(parseParams([])).toBeUndefined();
  });

  it("parses key=value pairs", () => {
    expect(parseParams(["ticket=IN-1234", "env=staging"])).toEqual({
      ticket: "IN-1234",
      env: "staging",
    });
  });

  it("allows empty value", () => {
    expect(parseParams(["flag="])).toEqual({ flag: "" });
  });
});

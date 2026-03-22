import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseArcJson, resolvePortDecls } from "../index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "arc-json-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseArcJson", () => {
  it("parses a full arc.json", () => {
    writeFileSync(
      join(tmpDir, "arc.json"),
      JSON.stringify({
        ports: [{ port: 3000, name: "web" }, { port: 5432, name: "postgres" }],
        sync: ["config.yaml", ".env"],
        compose: true,
        devcontainer: false,
      }),
    );

    const result = parseArcJson(tmpDir);
    expect(result).toEqual({
      ports: [{ port: 3000, name: "web" }, { port: 5432, name: "postgres" }],
      sync: ["config.yaml", ".env"],
      compose: true,
      devcontainer: false,
    });
  });

  it("returns null when no arc.json exists", () => {
    const result = parseArcJson(tmpDir);
    expect(result).toBeNull();
  });

  it("handles arc.json with only ports", () => {
    writeFileSync(
      join(tmpDir, "arc.json"),
      JSON.stringify({
        ports: [{ port: 8080 }],
      }),
    );

    const result = parseArcJson(tmpDir);
    expect(result).toEqual({ ports: [{ port: 8080 }] });
    expect(result!.sync).toBeUndefined();
  });
});

describe("resolvePortDecls", () => {
  it("converts arc.json ports to PortDecl array with source", () => {
    writeFileSync(
      join(tmpDir, "arc.json"),
      JSON.stringify({
        ports: [{ port: 3000, name: "web" }, { port: 5432 }],
      }),
    );

    const result = resolvePortDecls(tmpDir);
    expect(result).toEqual([
      { port: 3000, name: "web", source: "arc.json" },
      { port: 5432, source: "arc.json" },
    ]);
  });

  it("reads forwardPorts from devcontainer.json", () => {
    mkdirSync(join(tmpDir, ".devcontainer"));
    writeFileSync(
      join(tmpDir, ".devcontainer", "devcontainer.json"),
      JSON.stringify({ forwardPorts: [3000, 8080] }),
    );

    const result = resolvePortDecls(tmpDir);
    expect(result).toEqual([
      { port: 3000, source: "devcontainer.json" },
      { port: 8080, source: "devcontainer.json" },
    ]);
  });

  it("deduplicates ports — arc.json wins", () => {
    writeFileSync(
      join(tmpDir, "arc.json"),
      JSON.stringify({
        ports: [{ port: 3000, name: "web" }],
      }),
    );
    mkdirSync(join(tmpDir, ".devcontainer"));
    writeFileSync(
      join(tmpDir, ".devcontainer", "devcontainer.json"),
      JSON.stringify({ forwardPorts: [3000, 8080] }),
    );

    const result = resolvePortDecls(tmpDir);
    expect(result).toEqual([
      { port: 3000, name: "web", source: "arc.json" },
      { port: 8080, source: "devcontainer.json" },
    ]);
  });

  it("returns empty array when no config files exist", () => {
    const result = resolvePortDecls(tmpDir);
    expect(result).toEqual([]);
  });
});

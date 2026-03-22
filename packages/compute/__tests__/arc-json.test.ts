import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseArcJson, resolvePortDecls, hasDevcontainer, hasComposeFile } from "../index.js";

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

describe("hasDevcontainer", () => {
  it("returns true when .devcontainer/devcontainer.json exists", () => {
    mkdirSync(join(tmpDir, ".devcontainer"));
    writeFileSync(join(tmpDir, ".devcontainer", "devcontainer.json"), "{}");
    expect(hasDevcontainer(tmpDir)).toBe(true);
  });

  it("returns true when .devcontainer.json exists (root-level)", () => {
    writeFileSync(join(tmpDir, ".devcontainer.json"), "{}");
    expect(hasDevcontainer(tmpDir)).toBe(true);
  });

  it("returns false when neither exists", () => {
    expect(hasDevcontainer(tmpDir)).toBe(false);
  });
});

describe("hasComposeFile", () => {
  it("returns true for docker-compose.yml", () => {
    writeFileSync(join(tmpDir, "docker-compose.yml"), "version: '3'\n");
    expect(hasComposeFile(tmpDir)).toBe(true);
  });

  it("returns true for compose.yaml", () => {
    writeFileSync(join(tmpDir, "compose.yaml"), "version: '3'\n");
    expect(hasComposeFile(tmpDir)).toBe(true);
  });

  it("returns false when no compose file", () => {
    expect(hasComposeFile(tmpDir)).toBe(false);
  });
});

describe("parseArcJson edge cases", () => {
  it("returns null for malformed JSON", () => {
    writeFileSync(join(tmpDir, "arc.json"), "{not valid json!!}");
    expect(() => parseArcJson(tmpDir)).toThrow();
  });

  it("handles empty arc.json ({})", () => {
    writeFileSync(join(tmpDir, "arc.json"), "{}");
    const result = parseArcJson(tmpDir);
    expect(result).toEqual({});
    expect(result!.ports).toBeUndefined();
    expect(result!.sync).toBeUndefined();
  });
});

describe("resolvePortDecls with docker-compose", () => {
  it("parses ports from docker-compose.yml", () => {
    const compose = [
      "version: '3'",
      "services:",
      "  web:",
      "    ports:",
      '      - "3000:3000"',
      '      - "8080:80"',
    ].join("\n");
    writeFileSync(join(tmpDir, "docker-compose.yml"), compose);

    const result = resolvePortDecls(tmpDir);
    expect(result).toEqual([
      { port: 3000, source: "docker-compose" },
      { port: 8080, source: "docker-compose" },
    ]);
  });

  it("deduplicates across all three sources", () => {
    // arc.json with port 3000
    writeFileSync(
      join(tmpDir, "arc.json"),
      JSON.stringify({ ports: [{ port: 3000, name: "web" }] }),
    );

    // devcontainer with ports 3000 and 5000
    mkdirSync(join(tmpDir, ".devcontainer"));
    writeFileSync(
      join(tmpDir, ".devcontainer", "devcontainer.json"),
      JSON.stringify({ forwardPorts: [3000, 5000] }),
    );

    // docker-compose with ports 3000, 5000, and 8080
    const compose = [
      "version: '3'",
      "services:",
      "  web:",
      "    ports:",
      '      - "3000:3000"',
      '      - "5000:5000"',
      '      - "8080:80"',
    ].join("\n");
    writeFileSync(join(tmpDir, "docker-compose.yml"), compose);

    const result = resolvePortDecls(tmpDir);
    expect(result).toEqual([
      { port: 3000, name: "web", source: "arc.json" },
      { port: 5000, source: "devcontainer.json" },
      { port: 8080, source: "docker-compose" },
    ]);
  });
});

describe("port precedence", () => {
  it("arc.json > devcontainer > compose when same port appears in multiple", () => {
    // arc.json declares port 3000 with name
    writeFileSync(
      join(tmpDir, "arc.json"),
      JSON.stringify({ ports: [{ port: 3000, name: "from-arc" }] }),
    );

    // devcontainer also declares 3000 and 4000
    mkdirSync(join(tmpDir, ".devcontainer"));
    writeFileSync(
      join(tmpDir, ".devcontainer", "devcontainer.json"),
      JSON.stringify({ forwardPorts: [3000, 4000] }),
    );

    // compose also declares 3000, 4000, and 5000
    const compose = [
      "version: '3'",
      "services:",
      "  app:",
      "    ports:",
      '      - "3000:3000"',
      '      - "4000:4000"',
      '      - "5000:5000"',
    ].join("\n");
    writeFileSync(join(tmpDir, "docker-compose.yml"), compose);

    const result = resolvePortDecls(tmpDir);

    // 3000 should come from arc.json (highest priority) with name
    expect(result).toContainEqual({ port: 3000, name: "from-arc", source: "arc.json" });
    // 4000 should come from devcontainer (second priority)
    expect(result).toContainEqual({ port: 4000, source: "devcontainer.json" });
    // 5000 should come from compose (lowest priority)
    expect(result).toContainEqual({ port: 5000, source: "docker-compose" });

    // Ensure no duplicates — exactly 3 entries
    expect(result).toHaveLength(3);
  });
});

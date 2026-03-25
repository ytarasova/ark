import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  detectComposeFile,
  composeUp,
  composeDown,
  composePs,
  resolveComposePorts,
} from "../providers/docker/compose.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "docker-compose-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("detectComposeFile", () => {
  it("returns path for docker-compose.yml", () => {
    writeFileSync(join(tmpDir, "docker-compose.yml"), "version: '3'\n");
    const result = detectComposeFile(tmpDir);
    expect(result).toBe(join(tmpDir, "docker-compose.yml"));
  });

  it("returns path for compose.yaml", () => {
    writeFileSync(join(tmpDir, "compose.yaml"), "version: '3'\n");
    const result = detectComposeFile(tmpDir);
    expect(result).toBe(join(tmpDir, "compose.yaml"));
  });

  it("returns null when no compose file exists", () => {
    const result = detectComposeFile(tmpDir);
    expect(result).toBeNull();
  });
});

describe("resolveComposePorts", () => {
  it("extracts ports from compose file", () => {
    const compose = [
      "version: '3'",
      "services:",
      "  web:",
      "    image: nginx",
      "    ports:",
      '      - "3000:3000"',
      '      - "8080:80"',
    ].join("\n");
    writeFileSync(join(tmpDir, "docker-compose.yml"), compose);

    const result = resolveComposePorts(tmpDir);
    expect(result).toEqual([3000, 8080]);
  });

  it("returns empty array when no compose file exists", () => {
    const result = resolveComposePorts(tmpDir);
    expect(result).toEqual([]);
  });
});

describe("lifecycle functions exist", () => {
  it("composeUp is a function", () => {
    expect(typeof composeUp).toBe("function");
  });

  it("composeDown is a function", () => {
    expect(typeof composeDown).toBe("function");
  });

  it("composePs is a function", () => {
    expect(typeof composePs).toBe("function");
  });
});

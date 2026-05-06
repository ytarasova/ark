import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { discoverDevcontainerPorts } from "../devcontainer.js";
import { discoverComposePorts, findComposeFile } from "../docker-compose.js";
import { discoverWorkspacePorts } from "../ports.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ports-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("discoverDevcontainerPorts", () => {
  it("reads forwardPorts from .devcontainer/devcontainer.json", () => {
    mkdirSync(join(tmp, ".devcontainer"));
    writeFileSync(join(tmp, ".devcontainer/devcontainer.json"), JSON.stringify({ forwardPorts: [3000, 8080] }));
    expect(discoverDevcontainerPorts(tmp)).toEqual([{ port: 3000 }, { port: 8080 }]);
  });

  it("strips JSONC comments", () => {
    writeFileSync(join(tmp, "devcontainer.json"), `{ /* comment */ "forwardPorts": [4000] }`);
    expect(discoverDevcontainerPorts(tmp)).toEqual([{ port: 4000 }]);
  });

  it("returns empty array when no devcontainer file present", () => {
    expect(discoverDevcontainerPorts(tmp)).toEqual([]);
  });
});

describe("discoverComposePorts", () => {
  it("reads service-level ports from docker-compose.yml", () => {
    writeFileSync(
      join(tmp, "docker-compose.yml"),
      `services:\n  web:\n    ports:\n      - "3000:3000"\n      - 8080\n`,
    );
    expect(discoverComposePorts(tmp)).toEqual([{ port: 3000 }, { port: 8080 }]);
  });

  it("returns empty array when no compose file present", () => {
    expect(discoverComposePorts(tmp)).toEqual([]);
  });
});

describe("findComposeFile", () => {
  it("locates docker-compose.yml", () => {
    writeFileSync(join(tmp, "docker-compose.yml"), "services: {}\n");
    expect(findComposeFile(tmp)).toBe(join(tmp, "docker-compose.yml"));
  });

  it("returns null when no compose file present", () => {
    expect(findComposeFile(tmp)).toBeNull();
  });
});

describe("discoverWorkspacePorts", () => {
  it("merges and dedupes across both formats", () => {
    mkdirSync(join(tmp, ".devcontainer"));
    writeFileSync(join(tmp, ".devcontainer/devcontainer.json"), JSON.stringify({ forwardPorts: [3000, 4000] }));
    writeFileSync(join(tmp, "docker-compose.yml"), `services:\n  web:\n    ports:\n      - 3000\n      - 5000\n`);
    expect(
      discoverWorkspacePorts(tmp)
        .map((p) => p.port)
        .sort((a, b) => a - b),
    ).toEqual([3000, 4000, 5000]);
  });
});

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
    expect(discoverDevcontainerPorts(tmp)).toEqual([
      { port: 3000, source: "devcontainer.json" },
      { port: 8080, source: "devcontainer.json" },
    ]);
  });

  it("strips JSONC comments", () => {
    writeFileSync(join(tmp, "devcontainer.json"), `{ /* comment */ "forwardPorts": [4000] }`);
    expect(discoverDevcontainerPorts(tmp)).toEqual([{ port: 4000, source: "devcontainer.json" }]);
  });

  it("returns empty array when no devcontainer file present", () => {
    expect(discoverDevcontainerPorts(tmp)).toEqual([]);
  });
});

describe("discoverComposePorts", () => {
  it("reads service-level ports from docker-compose.yml and tags source", () => {
    writeFileSync(
      join(tmp, "docker-compose.yml"),
      `services:\n  web:\n    ports:\n      - "3000:3000"\n      - 8080\n`,
    );
    expect(discoverComposePorts(tmp)).toEqual([
      { port: 3000, source: "docker-compose" },
      { port: 8080, source: "docker-compose" },
    ]);
  });

  it("extracts the HOST port from `host:container` strings", () => {
    writeFileSync(join(tmp, "docker-compose.yml"), `services:\n  web:\n    ports:\n      - "8080:3000"\n`);
    expect(discoverComposePorts(tmp).map((p) => p.port)).toEqual([8080]);
  });

  it("extracts the HOST port from `ip:host:container` strings", () => {
    writeFileSync(join(tmp, "docker-compose.yml"), `services:\n  web:\n    ports:\n      - "127.0.0.1:8080:3000"\n`);
    expect(discoverComposePorts(tmp).map((p) => p.port)).toEqual([8080]);
  });

  it("strips the `/proto` suffix", () => {
    writeFileSync(
      join(tmp, "docker-compose.yml"),
      `services:\n  web:\n    ports:\n      - "3000/tcp"\n      - "8080:3000/udp"\n`,
    );
    expect(discoverComposePorts(tmp).map((p) => p.port)).toEqual([3000, 8080]);
  });

  it("ignores port-range strings (unsupported)", () => {
    writeFileSync(
      join(tmp, "docker-compose.yml"),
      `services:\n  web:\n    ports:\n      - "3000-3005:3000-3005"\n      - 9000\n`,
    );
    expect(discoverComposePorts(tmp).map((p) => p.port)).toEqual([9000]);
  });

  it("reads long-form `published`/`target` objects", () => {
    writeFileSync(
      join(tmp, "docker-compose.yml"),
      `services:\n  web:\n    ports:\n      - target: 3000\n        published: 8080\n      - target: 4000\n`,
    );
    expect(discoverComposePorts(tmp).map((p) => p.port)).toEqual([8080, 4000]);
  });

  it("returns empty array on malformed YAML", () => {
    writeFileSync(join(tmp, "docker-compose.yml"), `services:\n  web:\n    ports: [unclosed\n`);
    expect(discoverComposePorts(tmp)).toEqual([]);
  });

  it("returns empty array when services has no ports field", () => {
    writeFileSync(join(tmp, "docker-compose.yml"), `services:\n  web:\n    image: nginx\n`);
    expect(discoverComposePorts(tmp)).toEqual([]);
  });

  it("returns empty array when ports is non-array (skips bad shape)", () => {
    writeFileSync(join(tmp, "docker-compose.yml"), `services:\n  web:\n    ports: "not-an-array"\n`);
    expect(discoverComposePorts(tmp)).toEqual([]);
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

  it("prefers docker-compose.yml over docker-compose.yaml", () => {
    writeFileSync(join(tmp, "docker-compose.yml"), "services: {}\n");
    writeFileSync(join(tmp, "docker-compose.yaml"), "services: {}\n");
    expect(findComposeFile(tmp)).toBe(join(tmp, "docker-compose.yml"));
  });

  it("falls back to compose.yml when no docker-compose.* present", () => {
    writeFileSync(join(tmp, "compose.yml"), "services: {}\n");
    expect(findComposeFile(tmp)).toBe(join(tmp, "compose.yml"));
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

/**
 * Unit tests for resolveDevcontainerShape. These are pure parsing tests --
 * no Docker, no tmux, no network. Fixtures live on disk under
 * __tests__/fixtures/devcontainer/ so the test reads them exactly as a real
 * user project would be read, but each case also builds its own tmpdir with a
 * fresh devcontainer.json so we can cover edge cases without cluttering the
 * shared fixtures tree.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { basename, join } from "path";
import { tmpdir } from "os";
import { resolveDevcontainerShape } from "../providers/docker/devcontainer-resolve.js";

// ── Shared tmpdir helpers ───────────────────────────────────────────────────

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "devcontainer-resolve-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/** Write a devcontainer.json under `workdir/.devcontainer/`. */
function writeDevcontainerJson(body: string): string {
  const dir = join(workdir, ".devcontainer");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "devcontainer.json");
  writeFileSync(path, body, "utf-8");
  return path;
}

// ── Missing file ────────────────────────────────────────────────────────────

describe("missing file", () => {
  it("returns null when no devcontainer.json exists anywhere", () => {
    const shape = resolveDevcontainerShape(workdir);
    expect(shape).toBeNull();
  });

  it("picks .devcontainer/devcontainer.json over top-level .devcontainer.json", () => {
    writeDevcontainerJson(JSON.stringify({ image: "from-nested" }));
    writeFileSync(join(workdir, ".devcontainer.json"), JSON.stringify({ image: "from-root" }));
    const shape = resolveDevcontainerShape(workdir);
    expect(shape).not.toBeNull();
    expect(shape!.image).toBe("from-nested");
  });

  it("falls back to top-level .devcontainer.json if the nested one is missing", () => {
    writeFileSync(join(workdir, ".devcontainer.json"), JSON.stringify({ image: "from-root" }));
    const shape = resolveDevcontainerShape(workdir);
    expect(shape).not.toBeNull();
    expect(shape!.image).toBe("from-root");
  });
});

// ── image / dockerFile / build ──────────────────────────────────────────────

describe("image-only", () => {
  it("passes through the image field and leaves compose fields null", () => {
    writeDevcontainerJson(JSON.stringify({ image: "mcr.microsoft.com/devcontainers/base:ubuntu" }));
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.image).toBe("mcr.microsoft.com/devcontainers/base:ubuntu");
    expect(shape.composeFile).toBeNull();
    expect(shape.composeService).toBeNull();
  });
});

describe("dockerFile branch", () => {
  it("leaves image null so buildDevcontainerImage can populate it later", () => {
    writeDevcontainerJson(JSON.stringify({ dockerFile: "Dockerfile" }));
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.image).toBeNull();
    expect(shape.composeFile).toBeNull();
    // raw.dockerFile preserved so buildDevcontainerImage can resolve it.
    expect(shape.raw.dockerFile).toBe("Dockerfile");
  });
});

describe("build block branch", () => {
  it("leaves image null and preserves build block in raw for the builder", () => {
    writeDevcontainerJson(
      JSON.stringify({
        build: {
          dockerfile: "Dockerfile.dev",
          context: "..",
          args: { NODE_VERSION: "20", TZ: "UTC" },
        },
      }),
    );
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.image).toBeNull();
    const build = shape.raw.build as Record<string, unknown>;
    expect(build.dockerfile).toBe("Dockerfile.dev");
    expect(build.context).toBe("..");
    expect(build.args).toEqual({ NODE_VERSION: "20", TZ: "UTC" });
  });
});

// ── dockerComposeFile ───────────────────────────────────────────────────────

describe("dockerComposeFile branch", () => {
  it("resolves a single compose file relative to .devcontainer/ and stores service", () => {
    writeDevcontainerJson(
      JSON.stringify({
        dockerComposeFile: "../docker-compose.yml",
        service: "app",
        image: "ignored-in-compose-branch",
      }),
    );
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.composeFile).toBe(join(workdir, "docker-compose.yml"));
    expect(shape.composeService).toBe("app");
    // Spec: image is ignored when dockerComposeFile is present.
    expect(shape.image).toBeNull();
  });

  it("picks the last entry when dockerComposeFile is an array (compose merge semantics)", () => {
    writeDevcontainerJson(
      JSON.stringify({
        dockerComposeFile: ["../docker-compose.yml", "../docker-compose.override.yml"],
        service: "web",
      }),
    );
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.composeFile).toBe(join(workdir, "docker-compose.override.yml"));
    expect(shape.composeService).toBe("web");
  });

  it("accepts an absolute compose file path without rewriting it", () => {
    writeDevcontainerJson(
      JSON.stringify({
        dockerComposeFile: "/abs/path/docker-compose.yml",
        service: "api",
      }),
    );
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.composeFile).toBe("/abs/path/docker-compose.yml");
  });
});

// ── mounts ──────────────────────────────────────────────────────────────────

describe("mounts", () => {
  it("normalizes source=,target= string form into -v bind syntax", () => {
    writeDevcontainerJson(
      JSON.stringify({
        image: "x",
        mounts: ["source=/host/src,target=/container/dst,type=bind"],
      }),
    );
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.mounts).toEqual(["/host/src:/container/dst"]);
  });

  it("normalizes the object form into -v bind syntax", () => {
    writeDevcontainerJson(
      JSON.stringify({
        image: "x",
        mounts: [{ source: "/host/two", target: "/container/two", type: "bind" }],
      }),
    );
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.mounts).toEqual(["/host/two:/container/two"]);
  });

  it("passes through entries already in plain `src:dst[:mode]` form", () => {
    writeDevcontainerJson(
      JSON.stringify({
        image: "x",
        mounts: ["/host/three:/container/three:ro"],
      }),
    );
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.mounts).toEqual(["/host/three:/container/three:ro"]);
  });

  it("skips entries it can't parse (no source or no target)", () => {
    writeDevcontainerJson(
      JSON.stringify({
        image: "x",
        mounts: [
          { source: "/host/ok", target: "/container/ok" },
          { source: "/missing-target" },
          { target: "/missing-source" },
          42, // wrong type
        ],
      }),
    );
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.mounts).toEqual(["/host/ok:/container/ok"]);
  });
});

// ── workspaceFolder ─────────────────────────────────────────────────────────

describe("workspaceFolder", () => {
  it("defaults to /workspaces/<basename(workdir)> when unset", () => {
    writeDevcontainerJson(JSON.stringify({ image: "x" }));
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.workspaceFolder).toBe(`/workspaces/${basename(workdir)}`);
  });

  it("honors an explicit workspaceFolder", () => {
    writeDevcontainerJson(JSON.stringify({ image: "x", workspaceFolder: "/repo" }));
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.workspaceFolder).toBe("/repo");
  });
});

// ── forwardPorts ────────────────────────────────────────────────────────────

describe("forwardPorts", () => {
  it("copies numeric entries through and drops non-numbers", () => {
    writeDevcontainerJson(
      JSON.stringify({
        image: "x",
        forwardPorts: [3000, 8080, "5432", null, 9090],
      }),
    );
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.forwardPorts).toEqual([3000, 8080, 9090]);
  });

  it("does NOT auto-inject 19300 (arkd port) -- that's the caller's job", () => {
    writeDevcontainerJson(JSON.stringify({ image: "x", forwardPorts: [3000] }));
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.forwardPorts).not.toContain(19300);
  });

  it("defaults to an empty array when forwardPorts is absent", () => {
    writeDevcontainerJson(JSON.stringify({ image: "x" }));
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.forwardPorts).toEqual([]);
  });
});

// ── postCreateCommand ───────────────────────────────────────────────────────

describe("postCreateCommand", () => {
  it("wraps string form in bash -lc", () => {
    writeDevcontainerJson(
      JSON.stringify({
        image: "x",
        postCreateCommand: "npm install && npm run build",
      }),
    );
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.postCreateCommand).toEqual(["bash", "-lc", "npm install && npm run build"]);
  });

  it("preserves array form as an argv vector", () => {
    writeDevcontainerJson(
      JSON.stringify({
        image: "x",
        postCreateCommand: ["npm", "install"],
      }),
    );
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.postCreateCommand).toEqual(["npm", "install"]);
  });

  it("is null when unset", () => {
    writeDevcontainerJson(JSON.stringify({ image: "x" }));
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.postCreateCommand).toBeNull();
  });
});

// ── features ────────────────────────────────────────────────────────────────

describe("features", () => {
  it("preserves features verbatim for a follow-up to consume", () => {
    writeDevcontainerJson(
      JSON.stringify({
        image: "x",
        features: {
          "ghcr.io/devcontainers/features/node:1": { version: "20" },
          "ghcr.io/devcontainers/features/docker-in-docker:2": {},
        },
      }),
    );
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.features).toEqual({
      "ghcr.io/devcontainers/features/node:1": { version: "20" },
      "ghcr.io/devcontainers/features/docker-in-docker:2": {},
    });
  });

  it("defaults to an empty object when unset", () => {
    writeDevcontainerJson(JSON.stringify({ image: "x" }));
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.features).toEqual({});
  });
});

// ── comments in JSON ────────────────────────────────────────────────────────

describe("jsonc parsing", () => {
  it("tolerates // line comments, /* block comments */, and trailing commas", () => {
    writeDevcontainerJson(`{
      // pick a base image
      "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
      /* forward the dev-server port for local work */
      "forwardPorts": [3000,],
      "postCreateCommand": "echo hi", // trailing comma below
    }`);
    const shape = resolveDevcontainerShape(workdir)!;
    expect(shape.image).toBe("mcr.microsoft.com/devcontainers/base:ubuntu");
    expect(shape.forwardPorts).toEqual([3000]);
    expect(shape.postCreateCommand).toEqual(["bash", "-lc", "echo hi"]);
  });
});

// ── checked-in fixtures ─────────────────────────────────────────────────────

describe("fixtures directory", () => {
  const fixturesRoot = join(import.meta.dir, "fixtures", "devcontainer");

  it("image-only fixture parses as image with default workspaceFolder", () => {
    const shape = resolveDevcontainerShape(join(fixturesRoot, "image-only"))!;
    expect(shape).not.toBeNull();
    expect(shape.image).toBe("mcr.microsoft.com/devcontainers/base:ubuntu");
    expect(shape.workspaceFolder).toBe("/workspaces/image-only");
  });

  it("compose fixture resolves composeFile to an absolute path", () => {
    const fixtureDir = join(fixturesRoot, "compose");
    const shape = resolveDevcontainerShape(fixtureDir)!;
    expect(shape.composeFile).toBe(join(fixtureDir, "docker-compose.yml"));
    expect(shape.composeService).toBe("devcontainer");
    expect(shape.image).toBeNull();
  });

  it("jsonc fixture parses despite comments and trailing commas", () => {
    const shape = resolveDevcontainerShape(join(fixturesRoot, "jsonc"))!;
    expect(shape.image).toBe("ubuntu:22.04");
    expect(shape.forwardPorts).toEqual([8080]);
  });
});

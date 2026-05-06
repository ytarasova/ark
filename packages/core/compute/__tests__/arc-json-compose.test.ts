/**
 * Parser + normalization tests for arc.json's `compose` and `devcontainer`
 * fields. The runtime side of compose is tested in docker-compose-runtime.test.ts;
 * this suite pins the shape contract.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { parseArcJson, normalizeArcJson, resolveArcCompose, DEFAULT_COMPOSE_FILE } from "../arc-json.js";
import type { ArcJson } from "../types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "arc-compose-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeArc(body: unknown): void {
  writeFileSync(join(tmpDir, "arc.json"), JSON.stringify(body));
}

describe("parseArcJson -- compose normalization", () => {
  it("normalizes `compose: true` to { file: 'docker-compose.yml' }", () => {
    writeArc({ compose: true });
    const parsed = parseArcJson(tmpDir);
    expect(parsed?.compose).toEqual({ file: DEFAULT_COMPOSE_FILE });
  });

  it("treats `compose: false` as disabled (omits the key)", () => {
    writeArc({ compose: false, ports: [{ port: 8080 }] });
    const parsed = parseArcJson(tmpDir);
    expect(parsed?.compose).toBeUndefined();
    // Other fields survive.
    expect(parsed?.ports).toEqual([{ port: 8080 }]);
  });

  it("treats missing `compose` as disabled", () => {
    writeArc({ ports: [{ port: 3000 }] });
    const parsed = parseArcJson(tmpDir);
    expect(parsed?.compose).toBeUndefined();
  });

  it("passes through `compose: { file }` as-is (value only)", () => {
    writeArc({ compose: { file: "deploy/docker-compose.prod.yml" } });
    const parsed = parseArcJson(tmpDir);
    expect(parsed?.compose).toEqual({ file: "deploy/docker-compose.prod.yml" });
  });

  it("passes through `compose: { inline }` as-is", () => {
    const inline = {
      services: { db: { image: "postgres:16", ports: ["5432:5432"] } },
    };
    writeArc({ compose: { inline } });
    const parsed = parseArcJson(tmpDir);
    expect(parsed?.compose).toEqual({ inline });
  });

  it("passes through `compose: { file, inline }` preserving both", () => {
    const inline = { services: { cache: { image: "redis:7" } } };
    writeArc({ compose: { file: "docker-compose.yml", inline, skipUp: true } });
    const parsed = parseArcJson(tmpDir);
    expect(parsed?.compose).toEqual({
      file: "docker-compose.yml",
      inline,
      skipUp: true,
    });
  });

  it("treats `compose: {}` (neither file nor inline) as disabled", () => {
    // An empty object isn't enough to act on. We fail quietly rather than
    // silently picking a default the user didn't ask for.
    writeArc({ compose: {} });
    const parsed = parseArcJson(tmpDir);
    expect(parsed?.compose).toBeUndefined();
  });

  it("rejects `compose: 123` with a TypeError", () => {
    writeArc({ compose: 123 });
    expect(() => parseArcJson(tmpDir)).toThrow(/compose.*must be a boolean or object/);
  });

  it("rejects `compose: []` with a TypeError", () => {
    writeArc({ compose: [] });
    expect(() => parseArcJson(tmpDir)).toThrow(/compose.*must be a boolean or object/);
  });

  it("rejects `compose: { file: 42 }` with a TypeError", () => {
    writeArc({ compose: { file: 42 } });
    expect(() => parseArcJson(tmpDir)).toThrow(/compose\.file.*non-empty string/);
  });

  it("rejects `compose: { file: '' }` with a TypeError", () => {
    writeArc({ compose: { file: "" } });
    expect(() => parseArcJson(tmpDir)).toThrow(/compose\.file.*non-empty string/);
  });

  it("rejects `compose: { inline: 'stringy' }` with a TypeError", () => {
    writeArc({ compose: { inline: "services:\n  web: {}" } });
    expect(() => parseArcJson(tmpDir)).toThrow(/compose\.inline.*object/);
  });

  it("rejects `compose: { inline: [1, 2] }` with a TypeError", () => {
    writeArc({ compose: { inline: [1, 2] } });
    expect(() => parseArcJson(tmpDir)).toThrow(/compose\.inline.*object/);
  });

  it("rejects `compose: { skipUp: 'yes' }` with a TypeError", () => {
    writeArc({ compose: { file: "compose.yml", skipUp: "yes" } });
    expect(() => parseArcJson(tmpDir)).toThrow(/skipUp.*boolean/);
  });

  it("rejects `compose: null` as typeof null is object -- but we explicitly exclude it", () => {
    // JSON.parse('{"compose": null}') yields null. We treat null same as
    // missing (disabled).
    writeArc({ compose: null });
    const parsed = parseArcJson(tmpDir);
    expect(parsed?.compose).toBeUndefined();
  });
});

describe("parseArcJson -- devcontainer normalization", () => {
  it("passes through `devcontainer: true`", () => {
    writeArc({ devcontainer: true });
    const parsed = parseArcJson(tmpDir);
    expect(parsed?.devcontainer).toBe(true);
  });

  it("keeps `devcontainer: false` as-is (back-compat)", () => {
    // The boolean `false` flavor is preserved so existing downstream checks
    // that test for strict false still work. `undefined` is only emitted when
    // the key is absent entirely.
    writeArc({ devcontainer: false });
    const parsed = parseArcJson(tmpDir);
    expect(parsed?.devcontainer).toBe(false);
  });

  it("passes through `devcontainer: { config }`", () => {
    writeArc({ devcontainer: { config: ".devcontainer/dev.json" } });
    const parsed = parseArcJson(tmpDir);
    expect(parsed?.devcontainer).toEqual({ config: ".devcontainer/dev.json" });
  });

  it("rejects `devcontainer: 'foo'` with a TypeError", () => {
    writeArc({ devcontainer: "foo" });
    expect(() => parseArcJson(tmpDir)).toThrow(/devcontainer.*boolean or object/);
  });

  it("rejects `devcontainer: { config: '' }` with a TypeError", () => {
    writeArc({ devcontainer: { config: "" } });
    expect(() => parseArcJson(tmpDir)).toThrow(/devcontainer\.config.*non-empty string/);
  });
});

describe("normalizeArcJson", () => {
  it("is idempotent on an already-normalized value", () => {
    const arc: ArcJson = { compose: { file: "docker-compose.yml" }, ports: [{ port: 3000 }] };
    const first = normalizeArcJson(arc);
    const second = normalizeArcJson(first);
    expect(second).toEqual(first);
  });

  it("does not touch other fields", () => {
    const arc: ArcJson = {
      ports: [{ port: 8080, name: "web" }],
      sync: ["config.yaml"],
      compose: true,
    };
    const result = normalizeArcJson(arc);
    expect(result.ports).toEqual(arc.ports);
    expect(result.sync).toEqual(arc.sync);
    expect(result.compose).toEqual({ file: DEFAULT_COMPOSE_FILE });
  });
});

describe("resolveArcCompose", () => {
  it("returns null for null arc.json", () => {
    expect(resolveArcCompose(null)).toBeNull();
  });

  it("returns null for undefined arc.json", () => {
    expect(resolveArcCompose(undefined)).toBeNull();
  });

  it("returns null when compose is missing", () => {
    expect(resolveArcCompose({ ports: [] })).toBeNull();
  });

  it("returns null when compose is false", () => {
    expect(resolveArcCompose({ compose: false })).toBeNull();
  });

  it("expands boolean true to the default file", () => {
    expect(resolveArcCompose({ compose: true })).toEqual({ file: DEFAULT_COMPOSE_FILE });
  });

  it("returns the config object intact", () => {
    const cfg = { file: "docker-compose.yml", inline: { services: {} } };
    expect(resolveArcCompose({ compose: cfg })).toEqual(cfg);
  });
});

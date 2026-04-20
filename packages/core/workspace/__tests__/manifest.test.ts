/**
 * Workspace manifest -- YAML round-trip + validation tests.
 *
 * Exercises `writeManifest`, `readManifest`, `validateManifest`, and
 * `manifestPath` against an isolated tmpdir per test (no AppContext needed --
 * the manifest module is pure FS + YAML).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  MANIFEST_FILENAME,
  manifestPath,
  readManifest,
  validateManifest,
  writeManifest,
  type WorkspaceManifest,
} from "../manifest.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "ark-manifest-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function sampleManifest(overrides: Partial<WorkspaceManifest> = {}): WorkspaceManifest {
  return {
    session_id: "s-abc1234567",
    workspace_id: "ws-xyz",
    primary_repo_id: null,
    repos: [
      {
        repo_id: "r-1",
        slug: "payments",
        local_path: join(workdir, "payments"),
        branch: "ark/sess-abc1234",
        commit: null,
        cloned: false,
      },
    ],
    created_at: "2026-04-20T12:00:00.000Z",
    ...overrides,
  };
}

describe("workspace manifest", () => {
  it("manifestPath returns <workdir>/.ark-workspace.yaml", () => {
    expect(manifestPath(workdir)).toBe(join(workdir, MANIFEST_FILENAME));
  });

  it("writeManifest + readManifest round-trip preserves every field", () => {
    const original = sampleManifest({
      primary_repo_id: "r-1",
      repos: [
        {
          repo_id: "r-1",
          slug: "payments",
          local_path: join(workdir, "payments"),
          branch: "ark/sess-abc1234",
          commit: "deadbeef",
          cloned: true,
        },
        {
          repo_id: "r-2",
          slug: "auth-svc",
          local_path: join(workdir, "auth-svc"),
          branch: "ark/sess-abc1234",
          commit: null,
          cloned: false,
        },
      ],
    });

    const path = writeManifest(workdir, original);
    expect(path).toBe(join(workdir, MANIFEST_FILENAME));

    const loaded = readManifest(workdir);
    expect(loaded).toEqual(original);
  });

  it("readManifest returns null when no manifest exists (legacy single-repo workdir)", () => {
    expect(readManifest(workdir)).toBeNull();
  });

  it("readManifest throws on malformed YAML", () => {
    writeFileSync(manifestPath(workdir), "this is :\n  not: { valid yaml :::", "utf-8");
    expect(() => readManifest(workdir)).toThrow();
  });

  it("default manifest values: cloned=false, commit=null, primary_repo_id=null", () => {
    const m = sampleManifest();
    writeManifest(workdir, m);
    const loaded = readManifest(workdir)!;
    expect(loaded.repos[0].cloned).toBe(false);
    expect(loaded.repos[0].commit).toBeNull();
    expect(loaded.primary_repo_id).toBeNull();
  });

  it("writeManifest is idempotent: second write replaces first cleanly", () => {
    const a = sampleManifest({
      repos: [
        {
          repo_id: "r-1",
          slug: "a",
          local_path: join(workdir, "a"),
          branch: "ark/sess-abc1234",
          commit: null,
          cloned: false,
        },
      ],
    });
    writeManifest(workdir, a);
    const firstRaw = readFileSync(manifestPath(workdir), "utf-8");

    // Write the exact same manifest a second time -- contents should match.
    writeManifest(workdir, a);
    const secondRaw = readFileSync(manifestPath(workdir), "utf-8");
    expect(secondRaw).toBe(firstRaw);

    // And rewriting with a mutation produces a clean replacement.
    const b = sampleManifest({
      repos: [
        {
          repo_id: "r-1",
          slug: "a",
          local_path: join(workdir, "a"),
          branch: "ark/sess-abc1234",
          commit: "abc123",
          cloned: true,
        },
      ],
    });
    writeManifest(workdir, b);
    expect(readManifest(workdir)?.repos[0].cloned).toBe(true);
    expect(readManifest(workdir)?.repos[0].commit).toBe("abc123");
  });

  it("validateManifest rejects missing or malformed required fields", () => {
    expect(() => validateManifest(null as unknown as object)).toThrow(/must be an object/);
    expect(() => validateManifest({})).toThrow(/session_id/);
    expect(() => validateManifest({ session_id: "" })).toThrow(/session_id/);
    expect(() =>
      validateManifest({
        session_id: "s-1",
        workspace_id: "",
        created_at: "now",
        repos: [],
      }),
    ).toThrow(/workspace_id/);
    expect(() =>
      validateManifest({
        session_id: "s-1",
        workspace_id: "w-1",
        created_at: "now",
        repos: "nope",
      }),
    ).toThrow(/repos must be an array/);
    expect(() =>
      validateManifest({
        session_id: "s-1",
        workspace_id: "w-1",
        created_at: "now",
        repos: [{ repo_id: "r", slug: "s", local_path: "/p", branch: "b", cloned: "yes" }],
      }),
    ).toThrow(/cloned must be a boolean/);
  });
});

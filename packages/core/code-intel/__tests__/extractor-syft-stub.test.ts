/**
 * dependencies-syft extractor -- Wave 1 stub: syft is not yet vendored.
 * Test asserts the extractor declares unsupported and yields zero rows.
 * Wave 2 (vendor-syft.sh + checksum) will replace this with a fixture.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { dependenciesSyftExtractor } from "../extractors/dependencies-syft.js";
import { FilesystemVendorResolver } from "../vendor.js";
import type { ExtractorContext, Repo } from "../interfaces/index.js";
import type { CodeIntelStore } from "../store.js";

describe("dependenciesSyftExtractor (stub)", () => {
  it("declares the dependencies row kind", () => {
    expect(dependenciesSyftExtractor.produces).toContain("dependencies");
  });

  it("supports() returns false until syft is vendored", () => {
    const dir = mkdtempSync(join(tmpdir(), "ark-ci-syft-"));
    const repo: Repo = {
      id: "r",
      tenant_id: "t",
      repo_url: "file://" + dir,
      name: "r",
      default_branch: "main",
      local_path: dir,
    };
    expect(dependenciesSyftExtractor.supports(repo)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("yields zero rows when syft binary is missing", async () => {
    // Even when invoked directly (bypassing supports), the extractor
    // returns empty if VendorResolver can't locate syft.
    const dir = mkdtempSync(join(tmpdir(), "ark-ci-syft-run-"));
    const repo: Repo = {
      id: "r",
      tenant_id: "t",
      repo_url: "file://" + dir,
      name: "r",
      default_branch: "main",
      local_path: dir,
    };
    const ctx: ExtractorContext = {
      repo,
      run: {
        id: "run-x",
        tenant_id: "t",
        repo_id: "r",
        branch: "main",
        status: "running",
        started_at: new Date().toISOString(),
      },
      store: {} as CodeIntelStore,
      vendor: new FilesystemVendorResolver({ vendorDir: "/tmp/definitely-not-here-ark" }),
    };
    const rows: any[] = [];
    for await (const row of dependenciesSyftExtractor.run(ctx)) rows.push(row);
    expect(rows.length).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * dependencies-syft extractor -- runs `syft <repo> -o cyclonedx-json`,
 * persists `dependencies` rows.
 *
 * Wave 1 reality: `syft` is not yet vendored (`scripts/vendor-syft.sh` is
 * Wave 2 scope). The extractor declares `supports(repo) -> false` if the
 * binary is missing, with a clear "vendor syft to enable" message logged.
 *
 * The extractor + interface ship now so downstream wiring (pipeline,
 * doctor, CLI) can exercise the contract; flipping the switch later is a
 * one-line change once the script lands.
 */

import { existsSync } from "fs";
import type { Extractor, ExtractorContext, ExtractorRow } from "../interfaces/extractor.js";
import type { Repo } from "../interfaces/types.js";

interface SyftComponent {
  name: string;
  version?: string;
  type?: string;
  purl?: string;
}

interface SyftOutput {
  components?: SyftComponent[];
}

const PURL_KIND_PATTERN = /^pkg:([^/]+)\//i;

function purlKind(purl?: string): string {
  if (!purl) return "other";
  const m = purl.match(PURL_KIND_PATTERN);
  if (!m) return "other";
  const raw = m[1].toLowerCase();
  // Map purl ecosystem names to our manifest_kind canonical list.
  switch (raw) {
    case "npm":
      return "npm";
    case "pypi":
      return "pip";
    case "maven":
      return "maven";
    case "gradle":
      return "gradle";
    case "cargo":
      return "cargo";
    case "golang":
      return "go";
    case "gem":
      return "gem";
    case "composer":
      return "composer";
    case "nuget":
      return "nuget";
    default:
      return "other";
  }
}

export const dependenciesSyftExtractor: Extractor = {
  name: "dependencies-syft",
  produces: ["dependencies"],
  supports(repo: Repo): boolean {
    if (!repo.local_path || !existsSync(repo.local_path)) return false;
    return false; // Wave 1: syft not vendored. Vendor-syft script lands in Wave 2.
  },
  async *run(ctx: ExtractorContext): AsyncIterable<ExtractorRow> {
    let syftBin: string;
    try {
      syftBin = ctx.vendor.locateBinary("syft");
    } catch {
      // Vendor message + bail. Caller logs the skip via the run summary.
      return;
    }
    const proc = Bun.spawnSync({
      cmd: [syftBin, ctx.repo.local_path!, "-o", "cyclonedx-json"],
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((proc.exitCode ?? -1) !== 0) return;
    const raw = proc.stdout?.toString() ?? "";
    let parsed: SyftOutput;
    try {
      parsed = JSON.parse(raw) as SyftOutput;
    } catch {
      return;
    }
    for (const c of parsed.components ?? []) {
      if (ctx.signal?.aborted) return;
      yield {
        kind: "dependencies",
        row: {
          tenant_id: ctx.repo.tenant_id,
          repo_id: ctx.repo.id,
          file_id: null,
          manifest_kind: purlKind(c.purl),
          name: c.name,
          version_constraint: null,
          resolved_version: c.version ?? null,
          dep_type: "prod",
          indexing_run_id: ctx.run.id,
        },
      };
    }
  },
};

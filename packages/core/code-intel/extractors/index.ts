/**
 * Extractor registry -- the curated set shipped in Wave 1.
 *
 * Wave 2 adds: endpoints (per-framework .scm), configs, infra, openapi,
 * test_mappings, hotspots-recompute, doc-importer, embedder.
 */

import type { Extractor } from "../interfaces/extractor.js";
import { filesExtractor } from "./files.js";
import { gitContributorsExtractor } from "./git-contributors.js";
import { dependenciesSyftExtractor } from "./dependencies-syft.js";

export const WAVE1_EXTRACTORS: ReadonlyArray<Extractor> = [
  filesExtractor,
  gitContributorsExtractor,
  dependenciesSyftExtractor,
];

export { filesExtractor, gitContributorsExtractor, dependenciesSyftExtractor };

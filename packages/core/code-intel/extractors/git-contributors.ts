/**
 * git-contributors extractor -- runs `git log --all --numstat`, populates
 * `people` + `contributions` tables.
 *
 * One row per (person, repo) at the repo level (file_id NULL). File-level
 * rows lend themselves better to a hotspot extractor; that lands in Wave 2.
 *
 * People dedup is keyed on primary email; alt names get accumulated.
 */

import { existsSync } from "fs";
import { join } from "path";
import type { Extractor, ExtractorContext, ExtractorRow } from "../interfaces/extractor.js";
import type { Repo } from "../interfaces/types.js";
import { runGit } from "../util/git.js";

interface AggregatedPerson {
  email: string;
  name: string;
  commit_count: number;
  loc_added: number;
  loc_removed: number;
  first_commit: number;
  last_commit: number;
  alt_names: Set<string>;
}

const COMMIT_LINE = /^([a-f0-9]{7,40})\|([^|]*)\|([^|]*)\|(\d+)$/;

function parseGitLog(raw: string): Map<string, AggregatedPerson> {
  const out = new Map<string, AggregatedPerson>();
  let current: AggregatedPerson | null = null;

  for (const line of raw.split("\n")) {
    if (!line) {
      current = null;
      continue;
    }
    const commitMatch = line.match(COMMIT_LINE);
    if (commitMatch) {
      const [, , emailRaw, nameRaw, atRaw] = commitMatch;
      const email = (emailRaw ?? "unknown@unknown").trim().toLowerCase();
      const name = (nameRaw ?? "").trim();
      const at = parseInt(atRaw ?? "0", 10) * 1000;
      const existing = out.get(email);
      if (existing) {
        existing.commit_count += 1;
        existing.first_commit = Math.min(existing.first_commit, at);
        existing.last_commit = Math.max(existing.last_commit, at);
        if (name) existing.alt_names.add(name);
        current = existing;
      } else {
        const fresh: AggregatedPerson = {
          email,
          name,
          commit_count: 1,
          loc_added: 0,
          loc_removed: 0,
          first_commit: at,
          last_commit: at,
          alt_names: new Set(name ? [name] : []),
        };
        out.set(email, fresh);
        current = fresh;
      }
      continue;
    }
    // numstat line: <added>\t<removed>\t<path>; binary diffs use "-".
    if (current) {
      const parts = line.split("\t");
      if (parts.length >= 2) {
        const added = parseInt(parts[0] ?? "0", 10);
        const removed = parseInt(parts[1] ?? "0", 10);
        if (Number.isFinite(added)) current.loc_added += added;
        if (Number.isFinite(removed)) current.loc_removed += removed;
      }
    }
  }
  return out;
}

export const gitContributorsExtractor: Extractor = {
  name: "git-contributors",
  produces: ["people", "contributions"],
  supports(repo: Repo): boolean {
    return !!repo.local_path && existsSync(join(repo.local_path, ".git"));
  },
  async *run(ctx: ExtractorContext): AsyncIterable<ExtractorRow> {
    const repoPath = ctx.repo.local_path!;
    const log = runGit(repoPath, ["log", "--all", "--no-merges", "--numstat", "--pretty=format:%H|%ae|%an|%at"]);
    if (!log.ok) return;
    const aggregated = parseGitLog(log.stdout);
    for (const person of aggregated.values()) {
      if (ctx.signal?.aborted) return;
      const altNames = Array.from(person.alt_names).filter((n) => n && n !== person.name);
      yield {
        kind: "people",
        row: {
          tenant_id: ctx.repo.tenant_id,
          primary_email: person.email,
          name: person.name || person.email,
          alt_emails: [],
          alt_names: altNames,
        },
      };
      yield {
        kind: "contributions",
        row: {
          tenant_id: ctx.repo.tenant_id,
          // person_id is resolved at persist-time via primary_email lookup.
          person_email: person.email,
          repo_id: ctx.repo.id,
          file_id: null,
          commit_count: person.commit_count,
          loc_added: person.loc_added,
          loc_removed: person.loc_removed,
          first_commit: new Date(person.first_commit).toISOString(),
          last_commit: new Date(person.last_commit).toISOString(),
          indexing_run_id: ctx.run.id,
        },
      };
    }
  },
};

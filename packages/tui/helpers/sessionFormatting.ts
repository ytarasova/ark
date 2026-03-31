// ── Session detail pane formatting helpers ───────────────────────────────────
// Pure functions extracted from SessionsTab detail pane. No side effects, no I/O.

import { humanTokens } from "../helpers.js";

/** Format token usage into a display string, or null if no usage data. */
export function formatTokenDisplay(session: any): string | null {
  const u = (session.config as any)?.usage;
  if (!u) return null;
  return `${humanTokens(u.total_tokens)} (in:${humanTokens(u.input_tokens)} out:${humanTokens(u.output_tokens)} cache:${humanTokens(u.cache_read_input_tokens ?? 0)})`;
}

export interface FileLink {
  path: string;
  url: string | null;
}

/** Build file link data from session config. Returns null if no files changed. */
export function buildFileLinks(session: any): FileLink[] | null {
  const files: string[] | undefined = (session.config as any)?.filesChanged;
  if (!files?.length) return null;
  const ghBase = (session.config as any)?.github_url as string | null;
  return files.map(f => ({
    path: f,
    url: ghBase ? `${ghBase}/blob/main/${f}` : null,
  }));
}

export interface CommitLink {
  sha: string;
  shortSha: string;
  url: string | null;
}

/** Build commit link data from session config. Returns null if no commits. */
export function buildCommitLinks(session: any): CommitLink[] | null {
  const commits: string[] | undefined = (session.config as any)?.commits;
  if (!commits?.length) return null;
  const ghBase = (session.config as any)?.github_url as string | null;
  return commits.map(c => ({
    sha: c,
    shortSha: c.slice(0, 7),
    url: ghBase ? `${ghBase}/commit/${c}` : null,
  }));
}

/** Strip ANSI escape codes and control characters, filter blank lines, return last N lines. */
export function stripAnsiAndFilter(output: string, lastN = 12): string[] {
  return output
    .split("\n")
    .map(line => line
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")       // strip ANSI
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")  // strip control chars
    )
    .filter(line => line.trim())
    .slice(-lastN);
}

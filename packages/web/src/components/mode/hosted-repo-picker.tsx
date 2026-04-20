/**
 * HostedRepoPicker -- repository picker for hosted-mode Ark deployments.
 *
 * In hosted mode, the Ark control plane has no stable client filesystem:
 * sessions always run against a clonable git URL. The picker therefore:
 *
 *   - Requires input to look like a git URL (`git@host:owner/repo(.git)?` or
 *     `https://host/...`). Anything else is rejected inline.
 *   - Filters "recent repositories" down to entries that also look like URLs
 *     (local paths from a previous local-mode session are not usable here).
 *   - Does NOT offer "Browse for folder..." -- there's no client FS to browse.
 */

import { useState } from "react";
import { RepoPickerShell } from "./repo-picker-shell.js";
import type { RepoPickerProps } from "./binding-types.js";

/** Accept `git@host:owner/repo(.git)?` or `https?://host/owner/repo(.git)?`. */
const GIT_URL_RE = /^(git@[^:\s]+:[^\s]+|https?:\/\/[^\s]+)$/i;

export function HostedRepoPicker({ value, onChange, recentRepos }: RepoPickerProps) {
  const [error, setError] = useState<string | null>(null);

  function tryCommit(raw: string) {
    const v = raw.trim();
    if (!v) return;
    if (!GIT_URL_RE.test(v)) {
      setError("Remote mode requires a git URL (git@... or https://...)");
      return;
    }
    setError(null);
    onChange(v);
  }

  const visibleRecent = recentRepos.filter((r) => GIT_URL_RE.test(r.path));

  return (
    <RepoPickerShell
      value={value}
      onCommit={tryCommit}
      visibleRecent={visibleRecent}
      placeholder="git@github.com:owner/repo or https://..."
      error={error}
      onClearError={() => setError(null)}
    />
  );
}

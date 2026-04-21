import type { DetectedReference } from "./types.js";

const JIRA_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const GITHUB_ISSUE_RE = /(?:https?:\/\/github\.com\/([^\s/]+\/[^\s/]+)\/issues\/(\d+))|(?:#(\d+))/g;
const URL_RE = /https?:\/\/[^\s,)]+/g;

/**
 * Scan the task-description text and pull out Jira tickets, GitHub issue
 * references, and bare URLs. Each distinct reference only appears once even
 * if the user mentions it repeatedly; GitHub issue URLs are skipped by the
 * generic URL pass so they don't double-count.
 */
export function detectReferences(text: string): DetectedReference[] {
  const refs: DetectedReference[] = [];
  const seen = new Set<string>();

  // Jira references
  for (const m of text.matchAll(JIRA_RE)) {
    const key = `jira:${m[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ type: "jira", value: m[1], label: `${m[1]} (Jira)` });
    }
  }

  // GitHub issue references
  for (const m of text.matchAll(GITHUB_ISSUE_RE)) {
    if (m[1] && m[2]) {
      const key = `github:${m[1]}#${m[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ type: "github", value: `${m[1]}/issues/${m[2]}`, label: `${m[1]}#${m[2]} (GitHub)` });
      }
    } else if (m[3]) {
      const key = `github:#${m[3]}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ type: "github", value: `#${m[3]}`, label: `#${m[3]} (GitHub)` });
      }
    }
  }

  // Generic URLs (skip already-captured GitHub URLs)
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0];
    if (url.includes("github.com") && url.includes("/issues/")) continue;
    const key = `url:${url}`;
    if (!seen.has(key)) {
      seen.add(key);
      const short = url.replace(/^https?:\/\//, "").slice(0, 50);
      refs.push({ type: "url", value: url, label: short });
    }
  }

  return refs;
}

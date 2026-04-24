import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { useSessionTreeQuery } from "../../hooks/useSessionQueries.js";

/**
 * Parent-chain breadcrumb for child session detail pages.
 *
 * Given a session that has a non-null `parent_id`, we fetch the root's tree
 * (10s staleTime) and walk down to the current session id to produce the
 * chain `{root} › {parent} › {this}`. Each hop links to the corresponding
 * session detail page via the hash router.
 *
 * When the tree hasn't loaded yet or the session isn't found in it (e.g. the
 * root id we picked is wrong because we don't know the real root without
 * walking up), we skip rendering rather than flashing a partial crumb.
 */
export interface SessionBreadcrumbProps {
  session: { id: string; summary: string | null; parent_id: string | null };
}

export function SessionBreadcrumb({ session }: SessionBreadcrumbProps) {
  // We only know the direct parent id from the session row. The server's
  // `session/tree` endpoint rejects non-root ids, so we try it first with the
  // parent id and let the component bail on rejection. When the parent is
  // itself a child, the user will get an abbreviated crumb; the Flow tab's
  // full tree remains the source of truth.
  const rootCandidate = session.parent_id;
  const { data: root } = useSessionTreeQuery(rootCandidate);

  const chain = useMemo(() => (root ? buildChain(root, session.id) : null), [root, session.id]);

  if (!session.parent_id) return null;
  if (!chain || chain.length < 2) return null;

  // Drop the last crumb -- it's the current session's own summary, which
  // already renders as the SessionHeader's H1 title directly below. Showing
  // it here was a visual duplicate.
  const ancestors = chain.slice(0, -1);
  if (ancestors.length === 0) return null;

  return (
    <nav
      data-testid="session-breadcrumb"
      aria-label="Session ancestors"
      className="flex items-center gap-[6px] px-[18px] py-[6px] border-b border-[var(--border-light)]
        font-[family-name:var(--font-mono-ui)] text-[11px] text-[var(--fg-muted)] whitespace-nowrap overflow-hidden"
    >
      {ancestors.map((node, i) => (
        <span key={node.id} className="inline-flex items-center gap-[6px] min-w-0">
          {i > 0 && (
            <span aria-hidden className="text-[var(--fg-faint)] shrink-0">
              <ChevronRight size={11} />
            </span>
          )}
          <a
            href={`#/sessions/${node.id}`}
            className="text-[var(--fg-muted)] hover:text-[var(--fg)] truncate no-underline hover:underline"
            title={node.summary || node.id}
          >
            {truncate(node.summary || node.id, 40)}
          </a>
        </span>
      ))}
    </nav>
  );
}

interface ChainNode {
  id: string;
  summary: string | null;
}

/** Depth-first walk from the tree root to the target leaf. Returns the path. */
function buildChain(root: any, targetId: string): ChainNode[] | null {
  const path: any[] = [];
  const found = walk(root, targetId, path);
  if (!found) return null;
  return path.map((n) => ({ id: n.id, summary: n.summary ?? null }));
}

function walk(node: any, targetId: string, path: any[]): boolean {
  path.push(node);
  if (node.id === targetId) return true;
  const children = Array.isArray(node.children) ? node.children : [];
  for (const c of children) {
    if (walk(c, targetId, path)) return true;
  }
  path.pop();
  return false;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
